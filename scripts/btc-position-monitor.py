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

Env overrides:  BTC_MON_DIR (state/markers), BTC_TOKEN_FILE, BTR_STRIKE
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------- configuration
TOKEN_FILE = os.environ.get(
    "BTC_TOKEN_FILE", "/home/ubuntu/btc-straddle-0dte-coindcx/session.token"
)
REPO = os.environ.get("BTC_REPO_DIR", "/home/ubuntu/btc-straddle-0dte-coindcx")
STATE_DIR = os.environ.get("BTC_MON_DIR", "/home/ubuntu/.hermes/state/btc-pos-monitor")
API = "https://api.coindcx.com/api/v1/options/positions"
SPOT_API = "https://api.coindcx.com/exchange/ticker"

SL_MULTIPLIER = 2.0
PT_RATIO = 0.55
NEAR_SL_FRACTION = 0.85  # warn once a leg reaches 85% of its stop level

# Expiry clock: CoinDCX BTC options expire daily at 08:00 UTC (13:30 IST).
EXPIRY_UTC_HOUR = 8

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)

IST = timezone(timedelta(hours=5, minutes=30))


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
        with urllib.request.urlopen(req, timeout=25) as r:
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


def next_expiry() -> datetime:
    """The expiry the open legs belong to — next 08:00 UTC boundary."""
    n = datetime.now(timezone.utc)
    todays = n.replace(hour=EXPIRY_UTC_HOUR, minute=0, second=0, microsecond=0)
    return todays if n < todays else todays + timedelta(days=1)


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

    credit = sum(l["avg"] for l in legs)
    current = sum(l["mark"] for l in legs)
    pnl_points = credit - current
    pnl_cash = sum(l["upnl"] for l in legs)
    pt_points = credit * PT_RATIO
    expires = next_expiry()
    hours_left = (expires - datetime.now(timezone.utc)).total_seconds() / 3600

    # ---- INR reporting (the user reads P&L in rupees)
    # pnl_cash is USDT and pnl_points is premium points, so their ratio gives the
    # points->USDT factor (= position size) without hardcoding it.
    usd_per_point = (pnl_cash / pnl_points) if pnl_points else 0.01
    inr_rate = usdt_inr_rate()

    def inr(points: float) -> str:
        """Format a premium-points figure in rupees, or say so if the rate is unknown."""
        if not inr_rate:
            return "Rs rate N/A"
        return f"Rs {points * usd_per_point * inr_rate:,.2f}"

    def performance_block(title: str = "TRADE PERFORMANCE", note: str = "") -> str:
        """
        The house layout for performance reports: an emoji on every line, bold
        titles, Put before Call. Used by both the entry announcement and the
        recurring heartbeat so they can never drift apart.
        """
        pct = (pnl_points / pt_points * 100) if pt_points else 0.0
        remaining = max(0.0, 100.0 - pct)
        spot = fetch_spot()  # fetched here so the block never depends on call order
        strike = legs[0]["symbol"].split("-")[2]
        legs_sorted = sorted(legs, key=lambda x: 0 if x["kind"] == "P" else 1)
        strikes = "\n".join(
            f"{'🔻 Put' if l['kind'] == 'P' else '🔺 Call'}: {strike} —> "
            f"{l['mark']:.0f}/{l['sl']:.0f}"
            for l in legs_sorted
        )
        head = f"📊 **— {title} —**" + (f" ({note})" if note else "")
        return (
            f"{head}\n"
            f"🎯 **Target:** {pnl_points:+.0f}/{pt_points:.0f} pts "
            f"({pct:.0f}% achieved), remaining {remaining:.0f}%\n"
            f"💰 **Total Credit:** {credit:.0f} points ({inr(credit)})\n"
            f"📈 **Spot:** {spot:,.0f}\n"
            f"⚙️ **Strikes:**\n"
            f"{strikes}\n"
            f"⏰ {hours_left:.1f}h to expiry"
        )

    # ---- announce a newly seen position (entry confirmation)
    # Own it if the bot wrote a state file — keyed by ENTRY date, and a 0DTE entered
    # yesterday evening is still live today, so accept either day. Otherwise it was
    # placed by hand.
    state_dir = os.path.join(REPO, "state")
    try:
        yesterday = (now_ist() - timedelta(days=1)).strftime("%Y-%m-%d")
    except Exception:
        yesterday = today()
    bot_owned = any(
        os.path.exists(os.path.join(state_dir, f"straddle-state-{d}.json"))
        for d in (today(), yesterday)
    )
    # Key the "already announced" marker to the CONTRACT (expiry + legs), not the
    # calendar day: a position opened yesterday is the same position after midnight,
    # and re-announcing it (mis-labelled "manual") is pure noise.
    expiry_tag = next_expiry().strftime("%d%b%y").upper()
    open_key = "opened_" + expiry_tag + "_" + "_".join(sorted(l["kind"] for l in legs))
    opened_now = False
    if not seen(open_key):
        mark(open_key)
        opened_now = True
        who = "bot entry ✅" if bot_owned else "external/manual position"
        out.append(performance_block("TRADE OPENED", who))

    # ---- rule: per-leg stop loss
    for l in legs:
        key = f"sl_{l['kind']}"
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
            key = f"near_{l['kind']}"
            if not seen(key):
                mark(key)
                out.append(
                    f"⚠️ BTC — {l['kind']} leg approaching its stop\n"
                    f"{l['symbol']}  mark {l['mark']:.2f} vs stop {l['sl']:.2f} "
                    f"({l['mark'] / l['sl'] * 100:.0f}% of the way)"
                )

    # ---- rule: combined profit target
    if pnl_points >= pt_points:
        if not seen("pt"):
            mark("pt")
            out.append(
                f"🎯 BTC PROFIT TARGET HIT — +{pnl_points:.1f} pts ({inr(pnl_points)}), target +{pt_points:.1f} pts ({inr(pt_points)})\n"
                f"Combined unrealised {pnl_cash:+.4f} USD\n"
                f"👉 Action: CLOSE BOTH legs."
            )

    # ---- expiry milestones
    for hrs, key in ((4, "exp_4h"), (1, "exp_1h")):
        if 0 < hours_left <= hrs and not seen(key):
            mark(key)
            out.append(
                f"⏰ BTC STRADDLE — {hours_left:.1f}h to expiry "
                f"({expires.astimezone(IST):%H:%M} IST)\n"
                f"PnL {pnl_points:+.1f} pts of target {pt_points:.1f} · "
                f"CE {legs[0]['mark']:.0f} · PE {legs[-1]['mark']:.0f}"
            )

    # ---- hourly heartbeat
    hh = now_ist().strftime("%H")
    # Skip the hourly performance block when we just announced this same position —
    # otherwise the reader gets the identical table twice in one message.
    if not opened_now and not seen(f"hb_{hh}"):
        mark(f"hb_{hh}")
        out.append(performance_block())

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
            headers={"accept": "application/json", "User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
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

