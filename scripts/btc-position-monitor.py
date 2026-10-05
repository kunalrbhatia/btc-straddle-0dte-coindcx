#!/usr/bin/env python3
"""
BTC 0DTE straddle position monitor — REAL exchange data.

Reads the live position straight from CoinDCX's own options API:

    GET https://api.coindcx.com/api/v1/options/positions
    authorization: Bearer <session token minted by scripts/refresh-session.cjs>

That session is created *on this server* by the headless refresher, so its `sip`
claim matches this host's IP and the options API accepts it. Entry prices come
from the exchange (`avgPrice`), so nothing here is hardcoded or estimated.

Rules enforced (identical to the bot's):
  * per leg:  markPrice >= 2 x entry            -> STOP LOSS (BUY TO CLOSE)
  * combined: (credit - current premium) >= 55% of credit -> PROFIT TARGET

Behaviour: silent unless there is something to report. One alert per state
change (deduped via marker files), plus an hourly heartbeat so silence is
distinguishable from a dead monitor.

Env overrides:  BTC_MON_DIR (state/markers), BTC_TOKEN_FILE, BTC_REPO_DIR
"""
from __future__ import annotations

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------- configuration
REPO = os.environ.get("BTC_REPO_DIR", "/home/ubuntu/btc-straddle-0dte-coindcx")
TOKEN_FILE = os.environ.get(
    "BTC_TOKEN_FILE", os.path.join(REPO, "session.token")
)
STATE_DIR = os.environ.get("BTC_MON_DIR", "/home/ubuntu/.hermes/state/btc-pos-monitor")
API = "https://api.coindcx.com/api/v1/options/positions"
SPOT_API = "https://api.coindcx.com/exchange/ticker"

SL_MULTIPLIER = 2.0
PT_RATIO = 0.55
NEAR_SL_FRACTION = 0.85  # warn once a leg reaches 85% of its stop level

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)

IST = timezone(timedelta(hours=5, minutes=30))

# SSL context with graceful fallback for environments where local CA certs fail verification
_SSL_CTX = None
try:
    _SSL_CTX = ssl.create_default_context()
except Exception:
    pass


def _fetch_urlopen(req, timeout=25):
    global _SSL_CTX
    try:
        if _SSL_CTX:
            return urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" in str(e):
            ctx_no_verify = ssl.create_default_context()
            ctx_no_verify.check_hostname = False
            ctx_no_verify.verify_mode = ssl.CERT_NONE
            return urllib.request.urlopen(req, timeout=timeout, context=ctx_no_verify)
        raise


def load_env_expiry_utc_hour() -> int:
    """
    Reads DAILY_EXPIRY_HOUR_UTC from .env so the monitor and the bot cannot drift.
    Logs which value was used, and prints a warning if .env cannot be read.
    """
    env_path = os.path.join(REPO, ".env")
    val_from_env = None
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("#") or not line:
                        continue
                    if line.startswith("DAILY_EXPIRY_HOUR_UTC="):
                        val_str = line.split("=", 1)[1].split("#")[0].strip().strip('"').strip("'")
                        try:
                            val_from_env = int(val_str)
                        except ValueError:
                            pass
        except Exception as e:
            print(f"⚠️ BTC MONITOR — warning reading .env: {e}", file=sys.stderr)
    else:
        print(f"⚠️ BTC MONITOR — .env not found at {env_path}; using fallback", file=sys.stderr)

    if val_from_env is not None and 0 <= val_from_env <= 23:
        val = val_from_env
        src = f"from {env_path}"
    else:
        env_os = os.environ.get("DAILY_EXPIRY_HOUR_UTC")
        if env_os is not None:
            try:
                val = int(env_os)
                src = "from os.environ"
            except ValueError:
                val = 8
                src = "default fallback (8)"
        else:
            val = 8
            src = "default fallback (8)"

    # Log which value is used for visibility
    # (stderr to keep stdout clean for notifications)
    print(f"[Monitor Config] Using DAILY_EXPIRY_HOUR_UTC = {val} ({src})", file=sys.stderr)
    return val


EXPIRY_UTC_HOUR = load_env_expiry_utc_hour()


def now_ist() -> datetime:
    return datetime.now(timezone.utc).astimezone(IST)


def today() -> str:
    return now_ist().strftime("%Y-%m-%d")


# --------------------------------------------------------------- marker helpers
def _marker_path(name: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"{today()}.{name}")


def seen(name: str) -> bool:
    return os.path.exists(_marker_path(name))


def mark(name: str) -> None:
    try:
        with open(_marker_path(name), "w") as fh:
            fh.write(now_ist().isoformat())
    except OSError:
        pass


# ------------------------------------------------- forwarding the bot's alerts
def new_alert_lines() -> list[str]:
    """
    Forward anything the trading bot journalled (logs/alerts-<date>.jsonl) that we
    have not reported yet.

    The bot has no Telegram credentials of its own, so its fileAlerter journal is
    the only record of entry failures, auth errors and unwinds. Without this the
    most important event of the day — "the entry did not happen" — would be silent.
    """
    path = os.path.join(REPO, "logs", f"alerts-{today()}.jsonl")
    try:
        with open(path) as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
    except OSError:
        return []

    count_file = os.path.join(STATE_DIR, f"{today()}.alertcount")
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        reported = int(open(count_file).read().strip())
    except (OSError, ValueError):
        # First run of the day: record the baseline without replaying history.
        try:
            open(count_file, "w").write(str(len(lines)))
        except OSError:
            pass
        return []

    fresh, out = lines[reported:], []
    if fresh:
        try:
            open(count_file, "w").write(str(len(lines)))
        except OSError:
            pass
    for raw in fresh:
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        kind = str(rec.get("type") or rec.get("event") or rec.get("level") or "alert")
        msg = str(rec.get("message") or rec.get("msg") or "").strip() or raw[:200]
        icon = "🔴" if kind.lower() in ("error", "auth_error") else "🔔"
        out.append(f"{icon} BTC bot [{kind}]: {msg}")
    return out


# -------------------------------------------------------------------- fetching
def http_json(url: str, headers: dict) -> tuple[int, object]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _fetch_urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"_exc": str(e)}


def fetch_positions(token: str) -> tuple[int, list]:
    code, payload = http_json(
        API,
        {
            "authorization": f"Bearer {token}",
            "accept": "application/json",
            "Referer": "https://coindcx.com/",
            "User-Agent": UA,
        },
    )
    if code != 200 or not isinstance(payload, dict):
        return code, []
    data = payload.get("data") or {}
    rows = data.get("data") if isinstance(data, dict) else data
    return code, rows if isinstance(rows, list) else []


def fetch_spot() -> float:
    code, payload = http_json(SPOT_API, {"accept": "application/json", "User-Agent": UA})
    if code != 200 or not isinstance(payload, list):
        return 0.0
    for m in payload:
        if str(m.get("market", "")).upper() == "BTCUSDT":
            try:
                return float(m.get("last_price") or 0)
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def next_expiry(contract_expiry_tag: str | None = None) -> datetime:
    """
    The expiry the open legs belong to.
    Derives expiry directly from the contract symbol (e.g. 5OCT26 / 09OCT26) if available,
    falling back to next daily expiry UTC boundary arithmetic.
    """
    if contract_expiry_tag:
        try:
            # clean e.g. '5OCT26' or '05OCT26' -> '05OCT26'
            m = re.match(r"^(\d{1,2})([A-Z]{3})(\d{2})$", contract_expiry_tag.upper())
            if m:
                day = int(m.group(1))
                mon_str = m.group(2)
                year = 2000 + int(m.group(3))
                months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
                if mon_str in months:
                    mon = months.index(mon_str) + 1
                    return datetime(year, mon, day, EXPIRY_UTC_HOUR, 0, 0, tzinfo=timezone.utc)
        except Exception:
            pass

    n = datetime.now(timezone.utc)
    todays = n.replace(hour=EXPIRY_UTC_HOUR, minute=0, second=0, microsecond=0)
    return todays if n < todays else todays + timedelta(days=1)


# --------------------------------------------------------- historical artifacts
def load_historical_position_context(expiry_date_str: str) -> dict | None:
    """
    Checks state/straddle-state-<date>.json and logs/ for recorded facts about the position.
    Returns a dict with:
      - total_credit
      - target_profit_points
      - call_leg: dict (entryPrice, stopLossPrice, status, exitPrice, closeReason)
      - put_leg: dict
      - combined_pnl_from_log: float | None
    """
    state_dir = os.path.join(REPO, "state")
    logs_dir = os.path.join(REPO, "logs")

    # The entry state file could be named by entry date:
    # A position expiring on `expiry_date_str` was entered on that day or the day before.
    candidate_dates = [expiry_date_str]
    try:
        exp_dt = datetime.strptime(expiry_date_str, "%Y-%m-%d")
        candidate_dates.append((exp_dt - timedelta(days=1)).strftime("%Y-%m-%d"))
    except Exception:
        pass
    candidate_dates.extend([today(), (now_ist() - timedelta(days=1)).strftime("%Y-%m-%d")])
    # Deduplicate preserving order
    seen_dates = set()
    dedup_dates = []
    for d in candidate_dates:
        if d not in seen_dates:
            seen_dates.add(d)
            dedup_dates.append(d)

    found_state = None
    state_date_used = None
    for d in dedup_dates:
        p = os.path.join(state_dir, f"straddle-state-{d}.json")
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict) and data.get("entryExecuted"):
                        found_state = data
                        state_date_used = d
                        break
            except Exception:
                continue

    # Also check latest MTM log file for authorative combined PnL
    combined_pnl_from_log = None
    target_from_log = None
    for d in ([state_date_used] if state_date_used else []) + dedup_dates:
        if not d:
            continue
        mtm_file = os.path.join(logs_dir, f"mtm-{d}.log")
        if os.path.exists(mtm_file):
            try:
                with open(mtm_file, "r", encoding="utf-8") as f:
                    lines = [ln.strip() for ln in f if ln.strip()]
                    for ln in reversed(lines):
                        m = re.search(r"([\+\-]?[0-9]+(?:\.[0-9]+)?)\s+MTM", ln)
                        if m:
                            combined_pnl_from_log = float(m.group(1))
                            break
            except Exception:
                pass
            if combined_pnl_from_log is not None:
                break

    # Also check pm2 logs if present for latest [Monitor] line
    if combined_pnl_from_log is None:
        for pm2_name in ("pm2-out.log", "pm2-out-5.log"):
            pm2_file = os.path.join(logs_dir, pm2_name)
            if os.path.exists(pm2_file):
                try:
                    with open(pm2_file, "r", encoding="utf-8") as f:
                        lines = [ln.strip() for ln in f if "[Monitor]" in ln and "Combined PnL:" in ln]
                        if lines:
                            last_ln = lines[-1]
                            m = re.search(
                                r"Combined PnL:\s*([\+\-]?[0-9]+(?:\.[0-9]+)?)\s*/\s*([\+\-]?[0-9]+(?:\.[0-9]+)?)\s*pts",
                                last_ln,
                            )
                            if m:
                                combined_pnl_from_log = float(m.group(1))
                                target_from_log = float(m.group(2))
                                break
                except Exception:
                    pass
            if combined_pnl_from_log is not None:
                break

    if not found_state and combined_pnl_from_log is None:
        return None

    return {
        "state": found_state,
        "combined_pnl_from_log": combined_pnl_from_log,
        "target_from_log": target_from_log,
        "date": state_date_used,
    }


# ------------------------------------------------------------------------ main
def main() -> str:
    out: list[str] = []

    if not os.path.exists(TOKEN_FILE):
        if not seen("token_missing"):
            mark("token_missing")
            out.append(
                "🔑 BTC MONITOR — no session token\n"
                "Run: cd /home/ubuntu/btc-straddle-0dte-coindcx && npm run refresh-session"
            )
        return "\n".join(out)

    token = open(TOKEN_FILE).read().strip()
    code, rows = fetch_positions(token)

    # ---- auth / feed problems
    if code in (401, 403):
        if not seen("token_invalid"):
            mark("token_invalid")
            out.append(
                f"🔑 BTC MONITOR — session token rejected (HTTP {code})\n"
                "The monitor cannot read your position. Refresh with:\n"
                "cd /home/ubuntu/btc-straddle-0dte-coindcx && npm run refresh-session"
            )
        return "\n".join(out)

    if code != 200:
        if not seen("feed_down"):
            mark("feed_down")
            out.append(f"⚠️ BTC MONITOR — could not read positions (HTTP {code}); will keep retrying.")
        return "\n".join(out)

    # ---- flat: position gone (expired / closed)
    if not rows:
        if not seen("resolved"):
            mark("resolved")
            out.append("✅ BTC STRADDLE — position is CLOSED/EXPIRED. No open option legs remain.")
        return "\n".join(out)

    legs = []
    for p in rows:
        try:
            avg = float(p.get("avgPrice") or 0)
            mk = float(p.get("markPrice") or 0)
        except (TypeError, ValueError):
            continue
        if avg <= 0:
            continue
        legs.append(
            {
                "symbol": p.get("symbol", "?"),
                "kind": "C" if "-C-" in str(p.get("symbol")) else "P",
                "avg": avg,
                "mark": mk,
                "upnl": float(p.get("unrealisedPnl") or 0),
                "sl": avg * SL_MULTIPLIER,
            }
        )
    if not legs:
        return "\n".join(out)

    # Extract contract identity from the first leg
    sym_parts = legs[0]["symbol"].split("-")
    contract_expiry_tag = sym_parts[1].upper() if len(sym_parts) > 1 else ""
    strike = sym_parts[2] if len(sym_parts) > 2 else "0"

    # Derive calendar date string of the contract expiry
    expiry_date_str = today()
    try:
        # e.g. '5OCT26' or '05OCT26'
        clean_tag = contract_expiry_tag.zfill(7)
        parsed_dt = datetime.strptime(clean_tag, "%d%b%y")
        expiry_date_str = parsed_dt.strftime("%Y-%m-%d")
    except Exception:
        pass

    # Load recorded facts from bot artifacts (state store / MTM log)
    hist_ctx = load_historical_position_context(expiry_date_str)
    hist_state = hist_ctx.get("state") if hist_ctx else None

    # Track closed legs when only 1 leg is open
    closed_legs_info: list[dict] = []
    realised_pnl_unknown = False
    total_realised_pnl = 0.0

    original_credit = 0.0
    original_pt_points = 0.0

    if hist_state:
        original_credit = float(hist_state.get("totalCreditReceived") or 0.0)
        original_pt_points = float(hist_state.get("targetProfitPoints") or 0.0)
        call_active = hist_state.get("callLeg") or {}
        put_active = hist_state.get("putLeg") or {}

        open_kinds = {l["kind"] for l in legs}
        # If CALL is closed
        if "C" not in open_kinds and call_active:
            call_exit = call_active.get("exitPrice")
            call_entry = float(call_active.get("entryPrice") or 0.0)
            call_sl = float(call_active.get("stopLossPrice") or call_entry * SL_MULTIPLIER)
            call_reason = call_active.get("closeReason") or "CLOSED"
            if call_exit is not None:
                call_exit_val = float(call_exit)
                call_realised = call_entry - call_exit_val
            elif call_active.get("status") == "closed":
                call_exit_val = call_sl
                call_realised = call_entry - call_exit_val
            else:
                call_exit_val = None
                call_realised = None

            closed_legs_info.append({
                "kind": "C",
                "legType": "CALL",
                "symbol": call_active.get("symbol", f"BTC-{contract_expiry_tag}-{strike}-C-USDT"),
                "entry": call_entry,
                "exit": call_exit_val,
                "sl": call_sl,
                "realised": call_realised,
                "reason": call_reason,
            })

        # If PUT is closed
        if "P" not in open_kinds and put_active:
            put_exit = put_active.get("exitPrice")
            put_entry = float(put_active.get("entryPrice") or 0.0)
            put_sl = float(put_active.get("stopLossPrice") or put_entry * SL_MULTIPLIER)
            put_reason = put_active.get("closeReason") or "CLOSED"
            if put_exit is not None:
                put_exit_val = float(put_exit)
                put_realised = put_entry - put_exit_val
            elif put_active.get("status") == "closed":
                put_exit_val = put_sl
                put_realised = put_entry - put_exit_val
            else:
                put_exit_val = None
                put_realised = None

            closed_legs_info.append({
                "kind": "P",
                "legType": "PUT",
                "symbol": put_active.get("symbol", f"BTC-{contract_expiry_tag}-{strike}-P-USDT"),
                "entry": put_entry,
                "exit": put_exit_val,
                "sl": put_sl,
                "realised": put_realised,
                "reason": put_reason,
            })

    # Fallback to credit/pt derivation
    if original_credit <= 0:
        if len(legs) == 2:
            original_credit = sum(l["avg"] for l in legs)
            original_pt_points = original_credit * PT_RATIO
        elif hist_ctx and hist_ctx.get("target_from_log"):
            original_pt_points = float(hist_ctx["target_from_log"])
            original_credit = original_pt_points / PT_RATIO
        else:
            # Partial leg without recorded history
            original_credit = sum(l["avg"] for l in legs)
            original_pt_points = original_credit * PT_RATIO

    credit = original_credit
    pt_points = original_pt_points

    # Calculate combined PnL
    # Sum unrealised points for surviving legs: entry - mark
    surviving_unrealised_points = sum(l["avg"] - l["mark"] for l in legs)
    surviving_unrealised_cash = sum(l["upnl"] for l in legs)

    pnl_points = None
    if len(legs) == 2:
        pnl_points = surviving_unrealised_points
    elif len(legs) < 2:
        # Check if we have authoritative MTM log
        if hist_ctx and hist_ctx.get("combined_pnl_from_log") is not None:
            pnl_points = float(hist_ctx["combined_pnl_from_log"])
        else:
            # Compute from realised + unrealised if recorded
            all_realised_known = (
                len(closed_legs_info) > 0 and
                all(c["realised"] is not None for c in closed_legs_info)
            )
            if all_realised_known:
                total_realised = sum(c["realised"] for c in closed_legs_info)
                pnl_points = total_realised + surviving_unrealised_points
            else:
                pnl_points = None
                realised_pnl_unknown = True

    pnl_cash = surviving_unrealised_cash
    expires = next_expiry(contract_expiry_tag)
    hours_left = (expires - datetime.now(timezone.utc)).total_seconds() / 3600

    # ---- INR reporting (the user reads P&L in rupees)
    usd_per_point = 0.01  # Standard position lot: 0.01 BTC
    if pnl_points is not None and abs(pnl_points) > 0.001 and abs(surviving_unrealised_points) > 0.001:
        usd_per_point = abs(surviving_unrealised_cash / surviving_unrealised_points)

    inr_rate = usdt_inr_rate()

    def inr(points: float | None) -> str:
        """Format a premium-points figure in rupees, or say so if the rate is unknown."""
        if points is None:
            return "Rs UNAVAILABLE"
        if not inr_rate:
            return "Rs rate N/A"
        return f"Rs {points * usd_per_point * inr_rate:,.2f}"

    def performance_block(title: str = "TRADE PERFORMANCE", note: str = "") -> str:
        """
        The house layout for performance reports: an emoji on every line, bold
        titles, Put before Call.
        """
        if pnl_points is not None and pt_points > 0:
            pct = (pnl_points / pt_points * 100)
            remaining = max(0.0, 100.0 - pct)
            target_line = (
                f"🎯 **Target:** {pnl_points:+.0f}/{pt_points:.0f} pts "
                f"({pct:.0f}% achieved), remaining {remaining:.0f}%"
            )
        else:
            target_line = "🎯 **Target:** realised P&L UNAVAILABLE (partial leg set)"

        spot = fetch_spot()

        # Build strike display showing both legs (open or closed)
        strikes_rows = []
        for kind in ("P", "C"):
            open_leg = next((l for l in legs if l["kind"] == kind), None)
            closed_leg = next((c for c in closed_legs_info if c["kind"] == kind), None)
            label = "🔻 Put" if kind == "P" else "🔺 Call"
            if open_leg:
                strikes_rows.append(f"{label}: {strike} —> {open_leg['mark']:.0f}/{open_leg['sl']:.0f}")
            elif closed_leg:
                exit_str = f"{closed_leg['exit']:.0f}" if closed_leg['exit'] is not None else "closed"
                strikes_rows.append(f"{label}: {strike} —> {exit_str}/{closed_leg['sl']:.0f} (closed)")

        if not strikes_rows:
            legs_sorted = sorted(legs, key=lambda x: 0 if x["kind"] == "P" else 1)
            strikes_rows = [
                f"{'🔻 Put' if l['kind'] == 'P' else '🔺 Call'}: {strike} —> {l['mark']:.0f}/{l['sl']:.0f}"
                for l in legs_sorted
            ]

        strikes_str = "\n".join(strikes_rows)
        head = f"📊 **— {title} —**" + (f" ({note})" if note else "")
        return (
            f"{head}\n"
            f"{target_line}\n"
            f"💰 **Total Credit:** {credit:.0f} points ({inr(credit)})\n"
            f"📈 **Spot:** {spot:,.0f}\n"
            f"⚙️ **Strikes:**\n"
            f"{strikes_str}\n"
            f"⏰ {hours_left:.1f}h to expiry"
        )

    # ---- announce a newly seen position (entry confirmation)
    # Key the marker ONLY to the POSITION IDENTITY (contract expiry + strike),
    # NOT the leg set and NOT the calendar day. A leg closing is a state change,
    # not a new position.
    bot_owned = bool(hist_state)
    open_key = f"opened_{contract_expiry_tag}_{strike}"
    opened_now = False
    if not seen(open_key):
        mark(open_key)
        opened_now = True
        who = "bot entry ✅" if bot_owned else "external/manual position"
        out.append(performance_block("TRADE OPENED", who))

    # ---- announce leg state transitions (e.g. stop loss hit or closed)
    for c in closed_legs_info:
        closed_marker = f"closed_{contract_expiry_tag}_{strike}_{c['kind']}"
        if not seen(closed_marker):
            mark(closed_marker)
            exit_display = f"{c['exit']:.2f}" if c["exit"] is not None else "stop"
            if c["realised"] is not None:
                pnl_str = f"realised {c['realised']:+.0f} pts"
            else:
                pnl_str = "realised P&L UNAVAILABLE"
            other_kind = "PUT" if c["kind"] == "C" else "CALL"
            out.append(
                f"🛑 {c['legType']} stopped out at {exit_display} — {pnl_str} · "
                f"1 leg still open ({other_kind})"
            )

    # ---- rule: per-leg stop loss for surviving open legs
    for l in legs:
        key = f"sl_{contract_expiry_tag}_{strike}_{l['kind']}"
        if l["mark"] >= l["sl"]:
            if not seen(key):
                mark(key)
                out.append(
                    f"🛑 BTC STOP LOSS — {l['kind']} leg at its 2× stop\n"
                    f"{l['symbol']}\n"
                    f"mark {l['mark']:.2f} ≥ stop {l['sl']:.2f} (entry {l['avg']:.2f})\n"
                    f"loss on this leg ≈ {inr(l['sl'] - l['avg'])}\n"
                    f"👉 Action: BUY TO CLOSE this leg."
                )
        elif l["mark"] >= l["sl"] * NEAR_SL_FRACTION:
            key = f"near_{contract_expiry_tag}_{strike}_{l['kind']}"
            if not seen(key):
                mark(key)
                out.append(
                    f"⚠️ BTC — {l['kind']} leg approaching its stop\n"
                    f"{l['symbol']}  mark {l['mark']:.2f} vs stop {l['sl']:.2f} "
                    f"({l['mark'] / l['sl'] * 100:.0f}% of the way)"
                )

    # ---- rule: combined profit target
    # CRITICAL: Never fire target alert from partial leg set when realised P&L is unknown
    if len(legs) < 2 and (pnl_points is None or realised_pnl_unknown):
        # Suppress alerts and state why
        pass
    elif pnl_points is not None and pnl_points >= pt_points:
        if not seen(f"pt_{contract_expiry_tag}_{strike}"):
            mark(f"pt_{contract_expiry_tag}_{strike}")
            out.append(
                f"🎯 BTC PROFIT TARGET HIT — +{pnl_points:.1f} pts ({inr(pnl_points)}), "
                f"target +{pt_points:.1f} pts ({inr(pt_points)})\n"
                f"Combined unrealised {pnl_cash:+.4f} USD\n"
                f"👉 Action: CLOSE BOTH legs."
            )

    # ---- expiry milestones
    for hrs, key in ((4, "exp_4h"), (1, "exp_1h")):
        exp_marker = f"{key}_{contract_expiry_tag}_{strike}"
        if 0 < hours_left <= hrs and not seen(exp_marker):
            mark(exp_marker)
            pnl_disp = f"{pnl_points:+.1f} pts" if pnl_points is not None else "UNAVAILABLE"
            call_mark_str = next((f"{l['mark']:.0f}" for l in legs if l["kind"] == "C"), "closed")
            put_mark_str = next((f"{l['mark']:.0f}" for l in legs if l["kind"] == "P"), "closed")
            out.append(
                f"⏰ BTC STRADDLE — {hours_left:.1f}h to expiry "
                f"({expires.astimezone(IST):%H:%M} IST)\n"
                f"PnL {pnl_disp} of target {pt_points:.1f} · "
                f"CE {call_mark_str} · PE {put_mark_str}"
            )

    # ---- hourly heartbeat
    hh = now_ist().strftime("%H")
    hb_marker = f"hb_{hh}_{contract_expiry_tag}_{strike}"
    if not opened_now and not seen(hb_marker):
        mark(hb_marker)
        status_note = f"{len(legs)} of 2 legs open" if len(legs) < 2 else ""
        out.append(performance_block(note=status_note))

    return "\n".join(out)


# ---------------------------------------------------------------------------
# INR reporting
# ---------------------------------------------------------------------------
_USDT_INR: list = [None]  # per-run cache


def usdt_inr_rate() -> float | None:
    """
    The venue's own USDT/INR rate (CoinDCX public market data).

    Returns None when it cannot be read — callers must then print
    "rate UNAVAILABLE" rather than inventing a number. A made-up rate is just as
    dangerous as a made-up price: it turns a P&L into a fiction.
    """
    if _USDT_INR[0] is not None:
        return _USDT_INR[0]
    try:
        req = urllib.request.Request(
            "https://public.coindcx.com/market_data/current_prices",
            headers={"accept": "application/json", "User-Agent": UA},
        )
        with _fetch_urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        for key, val in (data or {}).items():
            ku = str(key).upper()
            if "USDT" in ku and "INR" in ku and "USDTINR" in ku.replace("_", ""):
                f = float(val)
                if 40 < f < 250:  # sanity band — reject absurd quotes
                    _USDT_INR[0] = f
                    return f
    except Exception:
        pass
    return None


if __name__ == "__main__":
    try:
        message = main()
    except Exception as exc:  # never die silently
        message = f"⚠️ BTC MONITOR error: {exc}"
    try:
        alerts = new_alert_lines()
    except Exception:
        alerts = []
    parts = alerts + ([message] if message else [])
    if parts:
        print("\n".join(parts))
