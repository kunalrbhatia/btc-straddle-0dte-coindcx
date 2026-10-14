# CoinDCX BTC 1 DTE Options Selling Bot

An automated **1 DTE short strangle** on CoinDCX bitcoin options. Every night it sells one Call and one
Put — 0.01 BTC each, with premiums in a $100–150 band — collects the credit, arms a stop on the venue for
each leg, and manages the position to one of three exits.

TypeScript, runs under PM2 on Linux with Node 22. A single long-lived process holds a once-a-day timer.

> 📺 Background on selling BTC options daily:
> [Bitcoin Daily Straddle Option Selling Strategy in Hindi (Theta Gainers)](https://www.youtube.com/watch?v=Mt0uebHIu7s)

---

> ## ⚠️ Read before you run this
>
> **It sells options, with real money.** The loss on a sold leg is not capped by the premium you collect.
> The protection is a **venue-side stop at 2× the premium on each leg** plus a **50%-of-credit** profit
> target, sized at 0.01 BTC per leg. A bad night has cost roughly the credit collected — on 13 Oct 2026
> both legs stopped out and the cycle lost **₹267** at 0.01 BTC. Use a funded but _dedicated_ account, not
> the one you keep your coins in, and watch your first few cycles by hand.
>
> The older **0 DTE ATM straddle** strategy is retired and locked out in code. Its manual is preserved at
> [`docs/0dte-retired.md`](docs/0dte-retired.md); much of the venue mechanics below is shared with it.

---

## 1. What it does, hour by hour

| When (IST)         | What happens                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **22:15**          | _(recommended)_ `npm run refresh-session` renews the CoinDCX web-session token                                                                                                                          |
| **22:45**          | **Entry.** Discovers the nearest expiry the venue lists, selects one Call and one Put priced in `[$100, $150]`, sells both as **marketable Limit** orders, each carrying a **venue stop at 2× premium** |
| 22:45→             | Confirms fills against **venue positions**, not the order list. A leg accepted but never filled is cancelled and the other leg is bought back                                                           |
| every 3 s          | Risk monitor: marks both legs, evaluates the exits                                                                                                                                                      |
| **17:45 next day** | **Scheduled exit** — both legs bought back `reduceOnly`                                                                                                                                                 |

Exits are: profit target, stop, or the scheduled exit (§6). Nothing else closes a position.

The entry is a once-a-day timer **inside the process**. Each cycle is persisted to
`state/onedte-state-<date>.json` and rebuilt from it on restart, so a restart resumes an open cycle
instead of entering a new one.

---

## 2. Before you start

- A **CoinDCX account with options enabled**, funded with USDT margin. Tonight's 0.01 BTC strangle reserved
  **≈₹7,800** (measured 13 Oct 2026) — keep a comfortable multiple of that in the account.
- **Node 22** and **npm**.
- **PM2 ≥ 7**.
- For the headless token refresh: the CoinDCX web **email + password**, the **TOTP secret** behind Google
  Authenticator, and a 16-character **Gmail app password**
  ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)).
- Optional: `npx playwright install chromium`.

> ⚠️ **The session token is bound to the IP that created it.** CoinDCX rejects options requests from any
> other IP with `401`. The bot must run on the machine whose IP you used when you refreshed. If your
> server's IP changes, refresh again. This is a venue rule, not a bug in the bot.

---

## 3. Install

```bash
git clone <this repo> && cd <repo>
npm ci                  # package-lock.json is committed
cp .env.example .env    # then fill it in (§5)
npm run build           # ⚠️ REQUIRED: dist/ is gitignored, and the bot runs dist/
```

Get a session token and start it:

```bash
npm run refresh-session                                 # headless login -> session.token
pm2 start ecosystem.config.js --only straddle-1dte
pm2 save                                                # survive a PM2 daemon restart
pm2 logs straddle-1dte --lines 40
```

### The go/no-go line

After any start or restart you must see this — it is the single test that the bot will trade:

```
[1DTE Scheduler] Arming daily entry schedule at 22:45 IST...
[Scheduler] Next execution set for: <today> 22:45:00 IST
[Scheduler] Waiting <n> seconds...
```

If it is missing, the bot will not enter, whatever else the log says. If the seconds don't land on 22:45,
check `ONEDTE_ENTRY_HOUR_IST` / `ONEDTE_ENTRY_MINUTE_IST`.

---

## 4. Running it day to day

- **It is a timer inside one process.** If that process dies, no entry happens, no exit happens, and
  _nothing tells you_. This is the failure mode that matters most.
- **The bot's own alerting is a file.** With no `TELEGRAM_BOT_TOKEN`, alerts are journaled to
  `logs/alerts-<date>.jsonl` and nothing is sent anywhere. That file is _also_ silent when the process
  dies, so it is not sufficient on its own.
- **Watch the process, not the journal.** The cheap reliable watchdog is a short cron (every 2 minutes)
  that reads PM2's pid file (`~/.pm2/pids/straddle-1dte-0.pid`), confirms the pid is alive, and confirms
  `/proc/<pid>/cmdline` still contains `dist/oneDte/index.js` — alerting **once** when it disappears and
  **once** when it returns. This deployment runs exactly that, and it earned its place immediately: on
  13 Oct the process died 20 minutes before the entry window and nothing else in the system noticed.
- `pm2 save` after every change; `pm2 startup` if the box should come back after a reboot.
- **Restart freely, except between 22:45 and 23:00** — the entry window. Any other time, a restart
  reconciles `state/` against the venue and resumes. An instance lock (`state/bot-1dte.lock`) prevents two
  copies running at once and self-heals a lock left by a dead pid.

---

## 5. Configuration (`.env`)

Everything is environment-driven; there are no hidden constants. The keys that matter for this bot:

| Key                                                                  | Default           | Meaning                                                                      |
| -------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `ONEDTE_ENTRY_HOUR_IST` / `ONEDTE_ENTRY_MINUTE_IST`                  | 22 / 45           | Entry time                                                                   |
| `ONEDTE_EXIT_HOUR_IST` / `ONEDTE_EXIT_MINUTE_IST`                    | 17 / 45           | Scheduled exit, next day                                                     |
| `ONEDTE_MIN_PREMIUM` / `ONEDTE_MAX_PREMIUM`                          | 100 / 150         | Band a leg's premium must sit in                                             |
| `ONEDTE_ORDER_QUANTITY`                                              | 0.01              | BTC per leg                                                                  |
| `ONEDTE_LEVERAGE`                                                    | 10                |                                                                              |
| `ONEDTE_SL_MULTIPLIER`                                               | 2.0               | Venue stop = entry × this                                                    |
| `ONEDTE_PROFIT_TARGET_RATIO`                                         | 0.50              | Exit when this share of the credit is earned                                 |
| `ONEDTE_POLL_INTERVAL_MS`                                            | 3000              | Risk-monitor cadence                                                         |
| `ONEDTE_PRICE_TICK`                                                  | 5                 | **Required by the venue** — see §7.1                                         |
| `ONEDTE_ENTRY_ORDER_TYPE`                                            | `Limit`           | Never `Market`: it skips quotes and loses the exchange stop                  |
| `ONEDTE_PREMIUM_SOURCE`                                              | `bid`             | Price source for strike selection and entry limits (`'bid'` or `'mark'`)     |
| `ONEDTE_ALLOW_OUT_OF_BAND_FALLBACK`                                  | `false`           | When `false`, aborts entry if no bid in band; `true` allows closest fallback |
| `ONEDTE_REQUOTE_AFTER_MS`                                            | `5000`            | Re-quote cadence (ms) when order is resting unfilled without position        |
| `ONEDTE_MAX_REQUOTES`                                                | `2`               | Max re-quote chase attempts before unwinding unfilled legs                   |
| `ONEDTE_STATE_DIR`                                                   | `./state`         | Where cycles are persisted                                                   |
| `COINDCX_SESSION_FILE`                                               | `./session.token` | Where the refresher writes the token                                         |
| `COINDCX_API_KEY` / `COINDCX_API_SECRET`                             | —                 | HMAC keys; the **options** API rejects them (§7.5)                           |
| `COINDCX_WEB_EMAIL` / `COINDCX_WEB_PASSWORD` / `COINDCX_TOTP_SECRET` | —                 | Only for `npm run refresh-session`                                           |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD`                                  | —                 | Only for the email OTP during refresh                                        |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`                            | empty             | Optional; unset means alerts only reach the journal                          |
| `DRY_RUN`                                                            | `false`           | `true` = log orders, send nothing                                            |

`.env` and `session.token` are gitignored. **The retired 0 DTE bot is separately gated** behind
`I_ACCEPT_0DTE_RISK=true` in `src/index.ts` — you never need it for this bot.

---

## 6. Exits, exactly

A leg is bought back (`reduceOnly`) on the first of:

1. **Profit target** — both legs together have earned `ONEDTE_PROFIT_TARGET_RATIO` × the credit collected.
   Only evaluated when _every_ leg has a live mark, so a stale or partial read can never look like a
   winner. Reason `PROFIT_TARGET_HIT`.
2. **Stop** — a leg's mark reaches `entry × ONEDTE_SL_MULTIPLIER`. In practice the **venue's own stop fires
   first**; the bot acts only if it doesn't (`SL_HIT`, or `SL_FALLBACK_CLOSE` when the mark overshoots).
3. **Scheduled exit** — 17:45 IST the next day (`MONITOR_WINDOW_ELAPSED`).

Note the contract's own expiry can fall _after_ the scheduled exit: the bot exits on the clock, not on
expiry. (The selector picks the nearest expiry the venue lists, and CoinDCX skips calendar dates — on
13 Oct 2026 a "1 DTE" entry selected the **15 OCT** expiry.)

---

## 7. Venue behaviours that will cost you a night if you don't know them

All handled in code. Documented because you will meet them in logs — each one cost a night to learn.

1. **Prices must be a multiple of ₹5.** Rounding produced 129 and 121, and the venue rejected the entry
   with `OCS-TECH-0013 "The min tick size should be 5."` Entry limits are therefore **floored, never
   rounded** (129.44 → 125), so a marketable limit can never round _up_ past the market.
2. **You cannot arm a stop after the fact.** There is no modify route, and a BUY's stop must sit _below_
   market, so a protective buy-to-close with an above-market trigger is refused outright. The stop goes
   **on the opening SELL**: `stopLoss = price × ONEDTE_SL_MULTIPLIER`. Confirm it after entry (§8).
3. **Position rows carry no quantity.** A row has `positionValue` (a **string**, negative for a short),
   `avgPrice`, `markPrice`, `stopLoss` — and **no `qty`**. Filtering on `qty` silently matches nothing, so
   every open leg looks closed. Detect positions by **row presence**; only `positionValue === 0` is flat.
4. **Every close must be reduce-only.** A duplicate close would flip a short into a long; the venue
   rejects it with `422 "…reduce-only… no open positions."`
5. **The options API wants the web session, not the HMAC keys.** Requests need
   `Authorization: Bearer <token>` **and** a browser `User-Agent`; HMAC is rejected with 401. The token is
   **IP-bound**, lives ~36 h, and the bot re-reads `session.token` on every request — so a refresh takes
   effect without a restart.
6. **The order API sometimes just says "retry".** `OCS-TECH-0024` ("Failed to place the order. Please
   retry.") is a transient create failure. The client fails over from `/api/v2` to `/api/v1`, and the
   fallback **does** carry the stop. You will see both lines; the order is fine.
7. **Error codes:** `OCS-TECH-0015` → dead session token, refresh it. `0013` → symbol/stop/tick problem.
   `0001` → missing parameter. `0002` → no route.
8. **Instruments are discovered, never computed.** The bot reads the public instruments feed and groups by
   expiry rather than deriving a date, because the venue's listing calendar skips days. If the feed is
   unreachable it logs loudly and falls back to arithmetic; if neither works it aborts with zero orders.
   Options sit on a **250 strike grid**.

---

## 8. Verify a live position (do this after your first entry)

```bash
cat state/onedte-state-<date>.json                # what the bot believes + the stops it intended
npm run verify -- --cycle <YYYY-MM-DD>            # reconciles the cycle's records against the venue
npm run doctor                                    # connectivity / token / account sanity
python3 scripts/btc-position-monitor.py           # standalone, read-only position monitor
```

Then confirm the two things that matter on the **resting orders**:

```
stopOrderType: StopLoss      # the stop exists
triggerPrice: 260            # == entry × ONEDTE_SL_MULTIPLIER
slTriggerBy: MarkPrice       # mark-triggered, not last-price
reduceOnly: True             # can only close, never flip you long
orderStatus: Untriggered     # armed, waiting
```

If those fields are absent, your stop is **not** armed — and then the profit target is all you have.

### Known cosmetic issue

The entry's journal message still uses the retired 0 DTE straddle wording (`🚀 BTC 0DTE Straddle Entered`,
`ATM Strike: $…`). The legs, strikes and fills printed beneath it are the 1 DTE strangle's and are correct.
Cosmetic only.

---

## 9. Commands, tests and safe modes

| Command                                              | What it does                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                      | Compile `src/` → `dist/` (the bot runs `dist/`)                                                                                       |
| `npm run typecheck`                                  | `tsc --noEmit`                                                                                                                        |
| `npm test`                                           | The 1 DTE executor suite: tick flooring, fill verification, half-fill unwind                                                          |
| `npm run doctor`                                     | Live connectivity / token / account check                                                                                             |
| `npm run verify -- --cycle <date>`                   | Reconcile a cycle's recorded claims against the venue                                                                                 |
| `npm run plan`                                       | Read-only inspection: spot, strikes, expiry, margin preview — no orders                                                               |
| `DRY_RUN=true npm run run-once:1dte`                 | One full 1 DTE cycle, no orders sent                                                                                                  |
| `npm run start:1dte`                                 | Run the 1 DTE timer in the foreground (PM2 does this for you)                                                                         |
| `ALLOW_INSTANT_EXECUTION=true npm run run-once:1dte` | One 1 DTE cycle **immediately**, bypassing the 22:45 timer                                                                            |
| `npm run acceptance`                                 | Legacy 0 DTE acceptance suite — still asserts 0 DTE behaviour and reports failures for the retired path. **Not a gate for this bot.** |

`scripts/pre-commit-secrets.cjs` + `.githooks/` scan staged changes for tokens and secrets
(`npm run scan-secrets`, `npm run verify:hooks`).

---

## 10. Records, verification and reports

- **Per-cycle records** — `records/<date>.jsonl` (event ledger), `.mtm.jsonl` (mark-to-market tape) and
  `.summary.json` (materialized summary), each recursively scrubbed of secrets.
- **Venue verification** — every recorded claim is checked against the broker terminal and judged
  `MATCH` / `MISMATCH` / `UNVERIFIED`, with an overall `VERIFIED` / `PARTIAL` / `FAILED` verdict.
- **Daily reports** — generated at expiry + `REPORT_DELAY_MINUTES` and published to the bot-owned
  `reports` branch via isolated git plumbing, never touching `main`:

  ```bash
  npm run report -- --cycle 2026-10-13 --stdout     # print
  npm run report -- --cycle 2026-10-13 --dry-run    # build, don't publish
  npm run report -- --cycle 2026-10-13              # publish to the reports branch
  ```

---

## 11. Session refresh

**Headless (recommended).** Set `COINDCX_WEB_EMAIL`, `COINDCX_WEB_PASSWORD`, `COINDCX_TOTP_SECRET`,
`GMAIL_USER`, `GMAIL_APP_PASSWORD` in `.env`, then:

```bash
npm run refresh-session
```

Headless stealth Chromium logs in, polls Gmail for the 2FA email OTP, generates the Authenticator TOTP,
and writes `session.token`.

A nightly cron is worth it — the token lasts ~36 h, so one refresh a day keeps a 22:45 entry covered:

```cron
30 0 * * * cd /path/to/repo && npm run refresh-session >> logs/refresh.log 2>&1
```

_(00:30 UTC = 06:00 IST. A system crontab runs in **UTC** while the bot thinks in IST.)_

**Manual fallback.** Log in to CoinDCX in Chrome → DevTools → **Network** → filter `options` → click any
`api/v1/options/...` request → copy the `authorization` header value → `echo "<token>" > session.token`.
Mind the IP binding.

---

## 12. Layout

```
src/oneDte/        config.ts · selector.ts · executor.ts · monitor.ts · stateStore.ts · index.ts
src/client.ts      CoinDCX client: orders, positions, wallet, v2→v1 fallback
src/records/       per-cycle ledger + venue verification
src/reports/       daily report generation and git publishing
scripts/           refresh-session.cjs · btc-position-monitor.py · acceptance runner · secret scanner
state/ logs/ records/ reports/    runtime artefacts (all gitignored)
```

---

## Disclaimer

Sold options carry unlimited risk in principle. This bot's protection is a stop order resting on the venue
plus a 50%-of-credit target, sized at 0.01 BTC per leg. Trade it with money you can afford to lose, on an
account you would not mind losing, and watch the first cycles by hand. No warranty; no liability for
losses.

---

## CoinDCX Referral & Rewards

> **Limited time: ₹10L worth of BTC rewards up for grabs!** 🚀
>
> Trade Spot or Futures on CoinDCX and win assured Bitcoin rewards worth up to ₹10L.
> Tap here to register: [CoinDCX Referral Sign Up](https://invite.coindcx.com/49594056)
>
> Let's make your first step the right one! 🚀
