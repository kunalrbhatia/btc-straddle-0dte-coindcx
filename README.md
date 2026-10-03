# CoinDCX BTC 0DTE ATM Straddle Automated Bot

Clean and strictly-typed TypeScript application designed to execute a **Short ATM Straddle** (sell ATM Call and Put options) on Bitcoin at **6:15 PM IST** using the CoinDCX API.

---

## Features
- **Strictly Typed**: Zero usage of the `any` keyword.
- **Accurate IST Timing**: Automatically calculates the exact delay until **6:15 PM IST** (18:15:00 IST) and executes daily.
- **Dynamic ATM Strike Selection**: Fetches live BTC price and rounds to the nearest ATM strike (e.g. $500 strike increments).
- **Concurrent Order Dispatch**: Sells both Call (CE) and Put (PE) simultaneously using `Promise.all`.
- **HMAC-SHA256 Authentication**: Conforms to CoinDCX API requirements (`X-AUTH-APIKEY`, `X-AUTH-SIGNATURE`, payload timestamp).
- **Modular SL / PT Hooks**: Prepared placeholder hooks to integrate Stop Loss (SL) and Profit Target (PT) logic once parameters are defined.

---

## Project Structure
```
straddle-btc-0dte/
├── src/
│   ├── client.ts       # CoinDCX API client & HMAC signing
│   ├── config.ts       # Environment & strategy configuration
│   ├── index.ts        # App entry point & scheduler lifecycle
│   ├── scheduler.ts    # Indian Standard Time (IST) timing engine
│   ├── straddle.ts     # ATM strike calculation & short straddle execution
│   └── types.ts        # Strongly-typed interfaces (no `any`)
├── .env.example        # Environment variable template
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

---

## Setup & Running

### 1. Configure Credentials
Copy `.env.example` to `.env` and fill in your CoinDCX API credentials:
```bash
cp .env.example .env
```

Edit `.env`:
```env
COINDCX_API_KEY=your_api_key_here
COINDCX_API_SECRET=your_api_secret_here
EXECUTION_HOUR_IST=18
EXECUTION_MINUTE_IST=15
ORDER_QUANTITY=1
LEVERAGE=10
SL_MULTIPLIER=2.0
PROFIT_TARGET_RATIO=0.55
POLL_INTERVAL_MS=2000
```

### 2. Run the Bot
- **Schedule for 6:15 PM IST daily**:
  ```bash
  npm start
  ```
- **Instant Test / Dry Run (`--now`)**:
  ```bash
  npx ts-node src/index.ts --now
  ```
- **Build Production JavaScript**:
  ```bash
  npm run build
  ```

