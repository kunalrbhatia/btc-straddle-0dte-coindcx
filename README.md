# CoinDCX BTC 0DTE ATM Straddle Automated Bot

Clean and strictly-typed TypeScript application designed to execute a **Short ATM Straddle** (sell ATM Call and Put options) on Bitcoin at **6:15 PM IST** using the CoinDCX API.

---

## Verified Exchange Mechanics & Architecture

1. **Option Expiry Timing**:
   - CoinDCX BTC options expire daily at **08:00 UTC (13:30 IST)**.
   - The bot enters at **18:15 IST** (~5 hours *after* that day's expiry). Therefore, "today's" contract no longer exists at entry time; the live tradeable contract is **tomorrow's expiry**. Contract symbol generation rolls automatically past 08:00 UTC via `nextExpiryDate()`.
2. **Session Authentication & IP Binding**:
   - CoinDCX options endpoints (`https://api.coindcx.com/api/v1/options/*`) require web session Bearer tokens (`authorization: Bearer <token>`) and the web browser session's `User-Agent`.
   - Standard API Key + HMAC is accepted only for spot and margin endpoints.
   - The session token's JWT carries a source IP claim (`sip`). Requests originating from a different IP return `401 Unauthorized`.
   - **Local execution**: The bot must run on the same machine/network as the user's browser session.
3. **Session Token Lifetime & Refresh**:
   - Session tokens are valid for **~36 hours**.
   - The token can be set via `COINDCX_SESSION_TOKEN` in `.env` or saved in `session.token` (or path via `COINDCX_SESSION_FILE`). The bot dynamically re-reads `session.token` on every request so a refreshed token takes effect immediately without restarting the bot.
   - On HTTP 401, the bot logs an error, journals an alert, and refuses to enter retry storms.
4. **Options Price Feed & Mark Resolution**:
   - Public market data endpoints do not carry options tickers or orderbooks.
   - Live mark prices are fetched from `GET /api/v1/options/positions` or the preview endpoint `POST /api/v1/options/margin`.
   - If the price feed is unavailable, the bot will never fabricate arbitrary prices; it alerts and halts.
5. **Margin Currency & Precision**:
   - Options are quoted on a **250 strike step grid** (e.g. 84750, 85000).
   - Position sizing: 0.01 BTC per leg at 10x leverage.
   - Note on balance: verify whether margin is held in USDT or INR before enabling live ordering.

---

## Features

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

### 1. Extracting CoinDCX Session Token

1. Open [CoinDCX](https://coindcx.com) in Google Chrome and log in.
2. Open Chrome DevTools (`F12` or `Ctrl+Shift+I`) and navigate to the **Network** tab.
3. Filter requests by `options` or visit the Options trading page.
4. Click on any request to `https://api.coindcx.com/api/v1/options/...` (e.g. `positions` or `margin`).
5. In the **Headers** panel under **Request Headers**, copy the value of the `authorization` header (omitting `Bearer ` or keeping the whole token).
6. Save this token into a file named `session.token` in the project root:
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
CONVERSION_RATE=102
STRIKE_STEP=250
EXECUTION_HOUR_IST=18
EXECUTION_MINUTE_IST=15

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
