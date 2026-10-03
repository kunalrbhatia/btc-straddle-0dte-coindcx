# CoinDCX BTC 0DTE ATM Straddle Automated Bot

Clean and strictly-typed TypeScript application designed to execute a **Short ATM Straddle** (sell ATM Call and Put options) on Bitcoin at **6:15 PM IST** using the CoinDCX API.

---

## Features
- **Strictly Typed**: Zero usage of the `any` keyword across the entire codebase (`strict: true`, `noImplicitAny: true`).
- **Accurate IST Timing**: Automatically calculates the exact delay until **6:15 PM IST** (`18:15:00 IST`) and executes daily.
- **Dynamic ATM Strike Selection**: Fetches live BTC price and rounds to the nearest ATM strike (e.g. $500 strike increments).
- **Concurrent Order Dispatch**: Sells both Call (CE) and Put (PE) simultaneously using `Promise.all`.
- **Fail-Safe Entry & Unwind**: If both orders fail, entry is aborted without fabricating prices. If only one leg fills (partial failure), the bot immediately places a buy-to-close order to unwind the filled leg, preventing naked exposure.
- **No Fabricated Prices**: Fill prices are parsed strictly from actual execution responses or validated live contract mark prices; never defaults to arbitrary numbers.
- **Defense in Depth**: Leg close commands will never fire without confirmation that the position was successfully opened.
- **State Persistence & Recovery**: Atomic disk writes to `state/straddle-state-<YYYY-MM-DD>.json` on every state transition. Automatically reconciles and resumes monitoring of open positions upon crash or restart.
- **MTM Watcher Logging**: Real-time tick-by-tick mark-to-market PnL tracking appended to daily log files (`logs/mtm-<YYYY-MM-DD>.log`) formatted with timestamp and current MTM.
- **Idempotency Guard**: Guarantees that today's entry is executed only once, skipping duplicate runs.
- **Telegram Alerting**: Integrated Telegram notifications for entries, stop-loss hits, profit target exits, partial failures, and startup reconciliation (gracefully disables if credentials are not provided).
- **Execution Safeguards**: The `--now` flag requires `ALLOW_INSTANT_EXECUTION=true` in environment to prevent unintentional manual live orders.

---

## Project Structure
```
straddle-btc-0dte/
├── src/
│   ├── client.ts         # CoinDCX API client & HMAC signing
│   ├── config.ts         # Environment & strategy configuration
│   ├── index.ts          # App entry point, startup reconciliation & scheduler
│   ├── mtmWatcher.ts     # Real-time MTM logging by date
│   ├── notifier.ts       # Telegram bot alerting module
│   ├── riskManager.ts    # Fill price resolution, SL/PT tracking & leg closure
│   ├── scheduler.ts      # Indian Standard Time (IST) timing engine
│   ├── stateStore.ts     # Atomic state persistence & idempotency checks
│   ├── straddle.ts       # ATM calculation, execution & partial entry unwinding
│   └── types.ts          # Strongly-typed interfaces (no `any`)
├── logs/                 # Daily MTM logs (logs/mtm-YYYY-MM-DD.log) & PM2 logs
├── state/                # Ignored directory for persisted daily state files
├── .env.example          # Environment variable template
├── ecosystem.config.js   # PM2 process supervisor configuration
├── package.json
└── tsconfig.json
```

---

## Risk Management & Exit Logic
- **Individual Leg Stop Loss (100% SL)**: If a leg was sold at 100 points, it is closed immediately via market buy when its market price touches or exceeds 200 points (2x entry).
- **Combined Profit Target (55% of Total Credit)**:
  - Total Credit = `Call Entry Price + Put Entry Price`.
  - Profit Target (Points) = `0.55 * Total Credit` (e.g. 100 + 100 = 200 pts credit -> 110 pts target profit).
  - When combined PnL across both legs reaches or exceeds +55% of credit, all remaining open legs are closed.
- **Three Resolution Scenarios Handled**:
  1. **Scenario 1 (`PROFIT_TARGET_REACHED`)**: Combined PnL hits 55% profit target with both legs riding; books profit and closes both.
  2. **Scenario 2 (`ONE_LEG_SL_OTHER_COVERED`)**: One leg triggers 100% SL, the remaining leg continues to decay and covers the loss to achieve the 55% net trade profit target.
  3. **Scenario 3 (`BOTH_LEGS_SL`)**: Extreme market move hits 100% SL on both legs; both positions are closed.
- **Max Duration Timeout**: Position is automatically squared off if monitoring exceeds configured cutoff (default: 12 hours).

---

## Setup & Running

### 1. Configure Credentials
Copy `.env.example` to `.env` and fill in your CoinDCX API credentials:
```bash
cp .env.example .env
```

Edit `.env`:
```env
# CoinDCX API Credentials
COINDCX_API_KEY=your_api_key_here
COINDCX_API_SECRET=your_api_secret_here
COINDCX_BEARER_TOKEN=your_jwt_bearer_token_here

# Strategy Settings
ORDER_QUANTITY=0.01
LEVERAGE=10
MARGIN_CURRENCY=USDT
CONVERSION_RATE=102
STRIKE_STEP=500
EXECUTION_HOUR_IST=18
EXECUTION_MINUTE_IST=15

# Risk Management
SL_MULTIPLIER=2.0
PROFIT_TARGET_RATIO=0.55
POLL_INTERVAL_MS=2000
MAX_MONITOR_MINUTES=720

# Optional Telegram Notifications
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Safety guard for instant manual execution
ALLOW_INSTANT_EXECUTION=false
```

### 2. Run the Bot
- **Schedule for 6:15 PM IST daily**:
  ```bash
  npm start
  ```
- **Instant Test / Manual Execution (`--now`)**:
  > **Note**: Requires setting `ALLOW_INSTANT_EXECUTION=true` in your environment or `.env` file to prevent accidental real orders.
  ```bash
  ALLOW_INSTANT_EXECUTION=true npx ts-node src/index.ts --now
  ```
- **Run Test Suite**:
  ```bash
  npm test
  ```
- **Build Production JavaScript**:
  ```bash
  npm run build
  ```
- **Run with PM2**:
  ```bash
  pm2 start ecosystem.config.js
  ```
