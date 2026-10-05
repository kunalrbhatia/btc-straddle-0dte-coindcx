# CoinDCX BTC 0DTE ATM Straddle Automated Bot

Clean and strictly-typed TypeScript application designed to execute a **Short ATM Straddle** (sell ATM Call and Put options) on Bitcoin at **6:15 PM IST** using the CoinDCX API.

📺 **Strategy Video Walkthrough**: [Bitcoin Daily Straddle Option Selling Strategy in Hindi (Theta Gainers)](https://www.youtube.com/watch?v=Mt0uebHIu7s)

---

## Verified Exchange Mechanics & Architecture

1. **Option Expiry Timing & Dynamic Discovery**:
   - CoinDCX BTC options typically expire at **08:00 UTC (13:30 IST)**, but the exchange skips calendar dates and follows a custom listing schedule (e.g. daily contracts for 3 days followed by weekly contracts).
   - **Discover, Don't Compute**: The bot dynamically queries CoinDCX's public options instruments endpoint (`GET https://public.coindcx.com/api/v1/options/instruments?baseCurrency=BTC`), groups by `expiryTime`, filters out expiries within `EXPIRY_MIN_LEAD_MINUTES` (default 30m), and selects the earliest active expiry alongside verbatim API contract symbols.
   - **Logged Fallback**: If the public instruments feed is temporarily unreachable, the bot logs a loud warning and falls back to arithmetic calendar derivation (`DAILY_EXPIRY_HOUR_UTC`, default 8 UTC). If neither works, it aborts cleanly with zero orders.
   - The standalone position monitor (`scripts/btc-position-monitor.py`) also derives expiry directly from the contract's own symbol rather than independent arithmetic.
2. **Session Authentication & IP Binding**:
   - CoinDCX options endpoints (`https://api.coindcx.com/api/v1/options/*`) require web session Bearer tokens (`authorization: Bearer <token>`) and the web browser session's `User-Agent`.
   - Standard API Key + HMAC is accepted for spot and margin endpoints, but rejected with 401 on options.
   - The session token's JWT carries a source IP claim (`sip`). Requests originating from a different IP return `401 Unauthorized`.
   - **Zero-Touch Headless Automation**: The bot can run fully headlessly on remote cloud servers (e.g. Oracle Linux / Ubuntu) by running `npm run refresh-session`. It uses Playwright with stealth evasions, retrieves the 6-digit email OTP from Gmail via IMAP, computes the Google Authenticator TOTP, submits 2FA, and captures the fresh session token into `session.token`.
3. **Session Token Lifetime & Refresh**:
   - Session tokens are valid for **~36 hours**.
   - The token can be refreshed automatically via `npm run refresh-session` or set statically via `COINDCX_SESSION_TOKEN` in `.env` or `session.token`. The bot dynamically re-reads `session.token` on every request so a refreshed token takes effect immediately without restarting the bot.
   - On HTTP 401, the bot logs an error, journals an alert, and refuses to enter retry storms.
4. **Options Price Feed & Marketable Limit Orders**:
   - Live mark prices, LTP, bid/ask are queried directly from CoinDCX's public options ticker (`https://public.coindcx.com/api/v1/options/ticker?baseCurrency=BTC&expiryTime=...`) and open positions (`GET /api/v1/options/positions`). The positions parser defensively unwraps nested payloads (`{ status: "success", data: { data: [...] } }`) as well as flat lists.
   - **Mark-to-Market Watcher & Loud Alerting**: If mark prices cannot be resolved for open legs during risk monitoring, the bot logs an explicit error and writes to the alert journal (`feed_unavailable`) instead of silently echoing entry prices as +0.00 PnL.
   - **Marketable Limit Entries**: The bot prices SELL entries from the public ticker's live `bidPrice` and places `Limit` orders (matching the CoinDCX web application). Selling directly into the bid ensures immediate marketable execution while eliminating undefined fill prices.
   - **Quote Validation & Fail-Safe Abort**: If `bidPrice` is missing, zero, or non-numeric for either leg, the bot refuses to fabricate prices: entry aborts immediately with zero orders sent and an alert is raised.
   - **Fill Confirmation & Unwind**: The bot polls `GET /api/v1/options/orders` (timeout configured via `ENTRY_FILL_TIMEOUT_MS`, default 15s). If neither leg fills, both are cancelled. If only one leg fills (partial fill timeout), the unfilled leg is cancelled and the filled leg is unwound immediately to avoid naked risk.
   - **Escape Hatch**: `ENTRY_ORDER_TYPE=Market` can be configured if needed, which skips price quotes but logs loudly that exchange-side stops are disabled.
5. **Exchange-Side Stop Loss & Bot-Side Profit Target**:
   - **Exchange-Side Stop Loss**: Along with the Limit order, the bot sends `stopLoss = limitPrice * SL_MULTIPLIER` (2 decimals, e.g. `416.00 -> 832.00`) directly in the order creation payload (`POST /api/v2/options/order/create`). This provides primary exchange-level stop protection even if the bot process or network drops.
   - **Bot-Side Profit Target**: The combined +55% profit target is a portfolio-level condition across both legs that exchange single-leg orders cannot express. Thus, `takeProfit: ''` is sent on order creation, and the bot's risk monitor manages the profit target and serves as secondary stop protection.
   - **Payload Match**: Order create payload matches the CoinDCX web application byte-for-byte (`{ symbol, side, orderType, qty, price, stopLoss, takeProfit }`), omitting `conversionRate`.
6. **Margin Currency & Precision**:
   - Options are quoted on a **250 strike step grid** (e.g. 84750, 85000).
   - Position sizing: 0.01 BTC per leg at 10x leverage.
   - Note on balance: verify whether margin is held in USDT or INR before enabling live ordering.

---

## Features

- **Zero-Touch Headless Session Refresher**: Fully automated headless login using Playwright stealth, automated Gmail IMAP OTP extraction, and RFC 6238 Google Authenticator TOTP generation (`npm run refresh-session`).
- **Strictly Typed**: Zero usage of the `any` keyword across the codebase (`strict: true`, `noImplicitAny: true`).
- **Accurate IST Timing**: Automatically calculates delay to **6:15 PM IST** (`18:15:00 IST`) with daily re-arming scheduler.
- **Dynamic Strike Selection**: Fetches live BTC price and rounds to the nearest ATM strike on CoinDCX's 250 grid.
- **Fail-Safe Entry & Unwind**: If both legs fail, entry aborts cleanly. If only one leg fills (partial failure), the bot immediately unwinds the filled leg via buy-to-close to avoid naked exposure.
- **Single-Instance Process Lock**: Exclusive PID lock file prevents duplicate local or PM2 instances from racing or cancelling each other's orders.
- **Safe Development Modes**:
  - `npm run plan`: Read-only inspection mode. Fetches spot, calculates strikes, validates contracts via margin preview, and displays projected SL/PT levels without placing any orders.
  - `DRY_RUN=true`: Simulates all order placements and cancellations without sending order network requests.
  - `npm run run-once`: Executes a single cycle.
- **MTM Watcher Logging**: Appends tick-by-tick mark-to-market PnL tracking to `logs/mtm-<YYYY-MM-DD>.log`.
- **Local Alert Journal**: Writes every alert to `logs/alerts-<YYYY-MM-DD>.jsonl` so local watch banners forward notifications even without Telegram bot credentials.

---

## Setup & Configuration

### 1. Automated Headless Session Refresh (Recommended)

To run the bot 100% autonomously without manually copying tokens from browser DevTools:

1. Create a 16-character **Google App Password** at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) for your Gmail account.
2. In your `.env`, configure:
   ```env
   COINDCX_WEB_EMAIL="your_email@gmail.com"
   COINDCX_WEB_PASSWORD="your_coindcx_password"
   COINDCX_TOTP_SECRET="your_authenticator_export_or_base32_secret"
   GMAIL_USER="your_email@gmail.com"
   GMAIL_APP_PASSWORD="your_16_char_app_password"
   ```
3. Run the automated session refresher:
   ```bash
   npm run refresh-session
   ```
   *(This automatically launches headless stealth Chromium, authenticates, polls Gmail for the 2FA email OTP, generates the Authenticator TOTP, logs in, and saves `session.token`).*

4. Optional Cron on Linux / Oracle Cloud (runs daily at 6:00 AM IST / 00:30 UTC):
   ```cron
   30 0 * * * cd /path/to/straddle-btc-0dte && npm run refresh-session >> logs/refresh.log 2>&1
   ```

### 2. Manual DevTools Fallback (Alternative)

If you prefer extracting manually:
1. Open [CoinDCX](https://coindcx.com) in Google Chrome and log in.
2. Open Chrome DevTools (`F12` or `Ctrl+Shift+I`) and navigate to the **Network** tab.
3. Filter requests by `options` or visit the Options trading page.
4. Click on any request to `https://api.coindcx.com/api/v1/options/...` (e.g. `positions` or `margin`).
5. Copy the `authorization` header value and save it to `session.token`:
   ```bash
   echo "your_token_here" > session.token
   ```
   *(Note: `session.token` and `.env` are gitignored).*

### 2. Configure Environment (`.env`)

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env`:
```env
# CoinDCX API Credentials
COINDCX_API_KEY=your_api_key_here
COINDCX_API_SECRET=your_api_secret_here

# Options Web Session Token (or leave blank to read from session.token)
COINDCX_SESSION_TOKEN=
COINDCX_SESSION_FILE=./session.token

# Strategy Settings
ORDER_QUANTITY=0.01
LEVERAGE=10
MARGIN_CURRENCY=USDT
# FALLBACK ONLY: the bot sends the live USDT/INR rate (read per entry from CoinDCX
# public market data). This value is used solely when that lookup fails.
CONVERSION_RATE=102
STRIKE_STEP=250

# Schedule & Expiry (Single Source of Truth: .env)
# Changing these here and restarting moves the entry time, PM2 restart, contract rollover, and monitor together.
EXECUTION_HOUR_IST=18        # Required (0-23): Entry hour in IST
EXECUTION_MINUTE_IST=15      # Required (0-59): Entry minute in IST
RESTART_LEAD_MINUTES=45      # Optional (default 45): PM2 pre-entry restart lead time
DAILY_EXPIRY_HOUR_UTC=8      # Optional (default 8 = 13:30 IST): Fallback 0DTE daily options expiry boundary in UTC
EXPIRY_MIN_LEAD_MINUTES=30   # Optional (default 30): Minimum minutes ahead required for chosen expiry

ENTRY_ORDER_TYPE=Limit
ENTRY_FILL_TIMEOUT_MS=15000

# Risk Management
SL_MULTIPLIER=2.0
PROFIT_TARGET_RATIO=0.55
POLL_INTERVAL_MS=2000
MAX_MONITOR_MINUTES=720

# Safe Mode / Testing
DRY_RUN=false
ALLOW_INSTANT_EXECUTION=false

# Optional Telegram Notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## Running the Bot

- **Plan Mode (Safe Inspection — No Orders)**:
  ```bash
  npm run plan
  ```
  Validates spot price, ATM strike derivation on 250 grid, next expiry date, margin preview, and prints SL/PT levels.

- **Run Single Cycle in Dry Run Mode (No Real Orders)**:
  ```bash
  DRY_RUN=true npm run run-once
  ```

- **Run Single Cycle Live**:
  ```bash
  ALLOW_INSTANT_EXECUTION=true npm run run-once
  ```

- **Start Daily Scheduler (6:15 PM IST)**:
  ```bash
  npm start
  ```

- **Run Tests**:
  ```bash
  npm test
  ```

- **Compile TypeScript**:
  ```bash
  npm run build
  ```

- **Typecheck**:
  ```bash
  npm run typecheck
  ```

---

## CoinDCX Referral & Rewards

> **Limited time: ₹10L worth of BTC rewards up for grabs!** 🚀
> 
> Trade Spot or Futures on CoinDCX and win assured Bitcoin rewards worth up to ₹10L.
> Tap here to register: [CoinDCX Referral Sign Up](https://invite.coindcx.com/49594056)
> 
> Let's make your first step the right one! 🚀

