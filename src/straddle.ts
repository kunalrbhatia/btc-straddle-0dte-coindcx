import { CoinDCXClient } from './client';
import {
  OrderItem,
  OrderPlacementOutcome,
  StraddleExecutionResult,
  StraddleLegs,
} from './types';
import { AppConfig } from './config';
import { initializeStraddleState, monitorStraddleRisk } from './riskManager';
import { Notifier } from './notifier';
import { getTodayDateStringIST, saveStraddleState } from './stateStore';
import { appendAlert } from './fileAlerter';

/**
 * Calculates the At-The-Money (ATM) strike price rounded to the nearest step.
 * e.g., For BTC spot $84,692 and step $500, ATM strike = $84,500.
 */
export function calculateAtmStrike(spotPrice: number, strikeStep: number): number {
  return Math.round(spotPrice / strikeStep) * strikeStep;
}

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/**
 * CoinDCX's BTC options expire every day at 08:00 UTC (= 13:30 IST).
 *
 * The bot enters at 18:15 IST — nearly five hours AFTER that day's expiry — so at
 * entry time "today's" contract no longer exists. The live (tradeable) contract is
 * the NEXT day's.
 *
 * Verified live 2026-10-03: at 18:15 IST the exchange's own order form used
 * `BTC-4OCT26-84750-C-USDT`, while the bot asked for `BTC-3OCT26-...` and was
 * rejected with " does not exist." — that single date error was the whole bug.
 */
const DAILY_EXPIRY_HOUR_UTC = 8;

/** The expiry date of the contract that is actually tradeable right now. */
export function nextExpiryDate(now = new Date()): Date {
  const todaysExpiryMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    DAILY_EXPIRY_HOUR_UTC,
    0,
    0,
    0
  );
  return now.getTime() >= todaysExpiryMs
    ? new Date(todaysExpiryMs + 24 * 60 * 60 * 1000)
    : new Date(todaysExpiryMs);
}

/**
 * Generates the contract symbols for Call (C) and Put (P) at the given strike.
 * Defaults to the NEXT tradeable expiry (see nextExpiryDate) rather than the
 * current calendar date.
 * e.g. BTC-4OCT26-84750-C-USDT / BTC-4OCT26-84750-P-USDT
 */
export function generateContractSymbols(
  atmStrike: number,
  targetDate = new Date()
): { readonly callSymbol: string; readonly putSymbol: string } {
  const expiry = nextExpiryDate(targetDate);
  const day = expiry.getUTCDate();
  const month = MONTH_NAMES[expiry.getUTCMonth()];
  const yy = String(expiry.getUTCFullYear()).slice(-2);
  const expiryStr = `${day}${month}${yy}`;

  const callSymbol = `BTC-${expiryStr}-${atmStrike}-C-USDT`;
  const putSymbol = `BTC-${expiryStr}-${atmStrike}-P-USDT`;

  return { callSymbol, putSymbol };
}

/**
 * Determines ATM straddle legs based on live BTC spot price or custom overrides
 */
export async function determineAtmStraddle(
  client: CoinDCXClient,
  config: AppConfig
): Promise<StraddleLegs> {
  const spotPrice = await client.getBtcSpotPrice();
  const atmStrike = calculateAtmStrike(spotPrice, config.strikeStep);
  const generated = generateContractSymbols(atmStrike);

  const callSymbol = config.customCallSymbol || generated.callSymbol;
  const putSymbol = config.customPutSymbol || generated.putSymbol;

  return {
    spotPrice,
    atmStrike,
    callSymbol,
    putSymbol,
  };
}

/**
 * Executes a Short ATM Straddle by selling ATM Call and ATM Put simultaneously.
 * Handles partial failures by squaring off any filled leg immediately.
 */
export async function executeShortStraddle(
  client: CoinDCXClient,
  config: AppConfig,
  notifier?: Notifier
): Promise<StraddleExecutionResult> {
  console.log('\n=============================================');
  console.log('[Straddle Strategy] Initiating 0DTE ATM Straddle Execution...');
  console.log('=============================================');

  // Step 1: Fetch live BTC spot price and determine ATM strike
  const legs = await determineAtmStraddle(client, config);

  console.log(`[Straddle] Live BTC Spot Price: $${legs.spotPrice.toFixed(2)}`);
  console.log(`[Straddle] Selected ATM Strike : $${legs.atmStrike}`);
  console.log(`[Straddle] Call Leg Symbol     : ${legs.callSymbol}`);
  console.log(`[Straddle] Put Leg Symbol      : ${legs.putSymbol}`);
  console.log(`[Straddle] Order Quantity      : ${config.orderQuantity}`);
  console.log(`[Straddle] Leverage            : ${config.leverage}x`);

  // Step 1b: PRE-FLIGHT instrument validation.
  // CoinDCX rejects unknown symbols with a blank-symbol error (" does not exist."),
  // which is undiagnosable and wastes the (once-daily) entry window. Verify both
  // contracts are actually listed on the exchange BEFORE sending any order:
  // a doomed order is useless, and a single filled leg is a naked short.
  //
  // Existence is checked via the margin preview (isContractListed), NOT via a price:
  // a contract can be listed while its mark is unavailable, and inferring existence
  // from a price is what previously led to a fabricated number.
  const [callListed, putListed] = await Promise.all([
    client.isContractListed(legs.callSymbol, String(config.orderQuantity)),
    client.isContractListed(legs.putSymbol, String(config.orderQuantity)),
  ]);

  if (!callListed || !putListed) {
    const errorMsg =
      `Pre-flight failed: contract not listed on CoinDCX — ` +
      `CALL ${legs.callSymbol} [${callListed ? 'listed' : 'NOT FOUND'}], ` +
      `PUT ${legs.putSymbol} [${putListed ? 'listed' : 'NOT FOUND'}]. ` +
      `NO orders were sent. Verify the 0DTE expiry date and symbol format.`;
    console.error(`[Straddle] 🚫 ${errorMsg}`);
    if (notifier) {
      void notifier.notifyEntryAborted({
        reason: errorMsg,
        callSuccess: false,
        putSuccess: false,
      });
    }
    return {
      executedAt: new Date(),
      success: false,
      partialFailure: false,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome: {
        symbol: legs.callSymbol,
        side: 'sell',
        success: false,
        message: 'pre-flight: contract not listed',
        rawResponse: {},
      },
      putOutcome: {
        symbol: legs.putSymbol,
        side: 'sell',
        success: false,
        message: 'pre-flight: contract not listed',
        rawResponse: {},
      },
      message: errorMsg,
    };
  }

  console.log(
    `[Straddle] Pre-flight OK       : both contracts listed (CALL ${legs.callSymbol}, PUT ${legs.putSymbol})`
  );

  const hasToken =
    typeof client.getBearerToken === 'function'
      ? Boolean(client.getBearerToken())
      : Boolean(config.bearerToken);

  let callPrice: number | undefined;
  let putPrice: number | undefined;
  let callStopLoss = '';
  let putStopLoss = '';

  // Step 2: Price the entry from live options ticker when placing Limit orders
  if (hasToken && config.entryOrderType === 'Limit') {
    const expiry = nextExpiryDate();
    const expiryTimeMs = expiry.getTime();

    const tickers = await client.getOptionsTicker('BTC', expiryTimeMs);
    const callTicker = tickers.find((t) => t.symbol === legs.callSymbol);
    const putTicker = tickers.find((t) => t.symbol === legs.putSymbol);

    const callBid = Number(callTicker?.bidPrice);
    const putBid = Number(putTicker?.bidPrice);

    if (!Number.isFinite(callBid) || callBid <= 0 || !Number.isFinite(putBid) || putBid <= 0) {
      const errorMsg =
        `Entry aborted: Missing or invalid bidPrice quote for straddle legs — ` +
        `CALL ${legs.callSymbol} bid: ${callTicker?.bidPrice ?? 'N/A'}, ` +
        `PUT ${legs.putSymbol} bid: ${putTicker?.bidPrice ?? 'N/A'}. ` +
        `NO orders were sent. Refusing to invent entry price.`;
      console.error(`[Straddle] 🚫 ${errorMsg}`);
      appendAlert('entry_aborted', errorMsg);
      if (notifier) {
        void notifier.notifyEntryAborted({
          reason: errorMsg,
          callSuccess: false,
          putSuccess: false,
        });
      }
      return {
        executedAt: new Date(),
        success: false,
        partialFailure: false,
        atmStrike: legs.atmStrike,
        spotPrice: legs.spotPrice,
        callOutcome: {
          symbol: legs.callSymbol,
          side: 'sell',
          success: false,
          message: 'missing bid quote',
          rawResponse: {},
        },
        putOutcome: {
          symbol: legs.putSymbol,
          side: 'sell',
          success: false,
          message: 'missing bid quote',
          rawResponse: {},
        },
        message: errorMsg,
      };
    }

    callPrice = Number(callBid.toFixed(2));
    putPrice = Number(putBid.toFixed(2));
    callStopLoss = (callPrice * config.riskConfig.stopLossMultiplier).toFixed(2);
    putStopLoss = (putPrice * config.riskConfig.stopLossMultiplier).toFixed(2);

    console.log(
      `[Straddle] CALL sell ${config.orderQuantity} @ limit ${callPrice.toFixed(2)} (bid ${callTicker?.bidPrice}) · exchange stopLoss ${callStopLoss}`
    );
    console.log(
      `[Straddle] PUT sell ${config.orderQuantity} @ limit ${putPrice.toFixed(2)} (bid ${putTicker?.bidPrice}) · exchange stopLoss ${putStopLoss}`
    );
  } else if (hasToken && config.entryOrderType === 'Market') {
    console.warn(
      '[Straddle] ⚠️ Warning: ENTRY_ORDER_TYPE is set to Market. Placing Market orders without exchange-side stop-loss protection.'
    );
  }

  // Step 3: Build Fallback HMAC Spot/Perp Orders (if no session token)
  const callOrder: OrderItem = {
    side: 'sell',
    pair: legs.callSymbol,
    order_type: 'market_order',
    price: '0',
    total_quantity: config.orderQuantity,
    leverage: config.leverage,
    notification: 'email_notification',
    time_in_force: 'immediate_or_cancel',
    hidden: false,
    post_only: false,
    margin_currency_short_name: [config.marginCurrency],
  };

  const putOrder: OrderItem = {
    side: 'sell',
    pair: legs.putSymbol,
    order_type: 'market_order',
    price: '0',
    total_quantity: config.orderQuantity,
    leverage: config.leverage,
    notification: 'email_notification',
    time_in_force: 'immediate_or_cancel',
    hidden: false,
    post_only: false,
    margin_currency_short_name: [config.marginCurrency],
  };

  console.log('[Straddle] Sending Sell orders for both legs concurrently...');

  // Step 4: Dispatch both sell orders concurrently
  const [callOutcome, putOutcome]: [OrderPlacementOutcome, OrderPlacementOutcome] =
    hasToken
      ? await Promise.all([
          client.placeOptionsOrder(
            legs.callSymbol,
            'sell',
            config.orderQuantity,
            config.entryOrderType,
            callPrice,
            callStopLoss,
            ''
          ),
          client.placeOptionsOrder(
            legs.putSymbol,
            'sell',
            config.orderQuantity,
            config.entryOrderType,
            putPrice,
            putStopLoss,
            ''
          ),
        ])
      : await Promise.all([
          client.placeOrder(callOrder),
          client.placeOrder(putOrder),
        ]);

  // Step 5: Log order outcomes
  logOutcome('CALL (CE)', callOutcome);
  logOutcome('PUT (PE)', putOutcome);

  const todayStr = getTodayDateStringIST();

  // Step 6: Handle execution outcome scenarios
  // Scenario A: Both legs placement failed
  if (!callOutcome.success && !putOutcome.success) {
    const errorMsg = 'Both Call and Put entry orders failed. Aborting straddle.';
    console.error(`[Straddle] ❌ ${errorMsg}`);
    if (notifier) {
      void notifier.notifyEntryAborted({
        reason: errorMsg,
        callSuccess: false,
        putSuccess: false,
      });
    }
    return {
      executedAt: new Date(),
      success: false,
      partialFailure: false,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message: errorMsg,
    };
  }

  // Scenario B: Partial Placement Failure - Call succeeded, Put failed
  if (callOutcome.success && !putOutcome.success) {
    const errorMsg = `Partial entry failure: Call succeeded (${legs.callSymbol}) but Put failed (${putOutcome.message || 'unknown'}). Squaring off Call immediately.`;
    console.error(`[Straddle] 🚨 ${errorMsg}`);

    // Immediately unwind the filled Call leg
    const unwindResult = await client.closePosition(legs.callSymbol, config.orderQuantity, config.leverage);
    console.log(`[Straddle] Unwound Call leg status: ${unwindResult.success ? 'SUCCESS' : 'FAILED'}`);

    if (notifier) {
      void notifier.notifyEntryAborted({
        reason: errorMsg,
        callSuccess: true,
        putSuccess: false,
        unwoundLeg: legs.callSymbol,
      });
    }

    return {
      executedAt: new Date(),
      success: false,
      partialFailure: true,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message: errorMsg,
      unwoundLeg: legs.callSymbol,
    };
  }

  // Scenario C: Partial Placement Failure - Put succeeded, Call failed
  if (!callOutcome.success && putOutcome.success) {
    const errorMsg = `Partial entry failure: Put succeeded (${legs.putSymbol}) but Call failed (${callOutcome.message || 'unknown'}). Squaring off Put immediately.`;
    console.error(`[Straddle] 🚨 ${errorMsg}`);

    // Immediately unwind the filled Put leg
    const unwindResult = await client.closePosition(legs.putSymbol, config.orderQuantity, config.leverage);
    console.log(`[Straddle] Unwound Put leg status: ${unwindResult.success ? 'SUCCESS' : 'FAILED'}`);

    if (notifier) {
      void notifier.notifyEntryAborted({
        reason: errorMsg,
        callSuccess: false,
        putSuccess: true,
        unwoundLeg: legs.putSymbol,
      });
    }

    return {
      executedAt: new Date(),
      success: false,
      partialFailure: true,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message: errorMsg,
      unwoundLeg: legs.putSymbol,
    };
  }

  // Step 7: Fill Confirmation for Limit Orders
  if (hasToken && config.entryOrderType === 'Limit') {
    console.log(
      `[Straddle] Polling for Limit order fills (timeout: ${config.entryFillTimeoutMs}ms)...`
    );
    const { callFilled, putFilled } = await waitForFills(
      client,
      legs.callSymbol,
      legs.putSymbol,
      callOutcome,
      putOutcome,
      config.entryFillTimeoutMs
    );

    // Case 1: Neither filled within timeout -> cancel both, zero exposure
    if (!callFilled && !putFilled) {
      const errorMsg = `Entry aborted: Neither Call nor Put limit order filled within ${config.entryFillTimeoutMs}ms. Cancelling both orders. Zero exposure.`;
      console.warn(`[Straddle] ⚠️ ${errorMsg}`);
      appendAlert('entry_timeout', errorMsg);

      await Promise.all([
        callOutcome.orderId ? client.cancelOptionsOrder(callOutcome.orderId, legs.callSymbol) : Promise.resolve(false),
        putOutcome.orderId ? client.cancelOptionsOrder(putOutcome.orderId, legs.putSymbol) : Promise.resolve(false),
      ]);

      if (notifier) {
        void notifier.notifyEntryAborted({
          reason: errorMsg,
          callSuccess: false,
          putSuccess: false,
        });
      }

      return {
        executedAt: new Date(),
        success: false,
        partialFailure: false,
        atmStrike: legs.atmStrike,
        spotPrice: legs.spotPrice,
        callOutcome,
        putOutcome,
        message: errorMsg,
      };
    }

    // Case 2: Call filled, Put did NOT fill -> cancel Put, immediately unwind Call
    if (callFilled && !putFilled) {
      const errorMsg = `Partial fill timeout: Call filled (${legs.callSymbol}) but Put timed out unfilled (${legs.putSymbol}). Cancelling Put and unwinding Call immediately.`;
      console.error(`[Straddle] 🚨 ${errorMsg}`);
      appendAlert('partial_fill_timeout', errorMsg);

      if (putOutcome.orderId) {
        await client.cancelOptionsOrder(putOutcome.orderId, legs.putSymbol);
      }
      const unwindResult = await client.closePosition(legs.callSymbol, config.orderQuantity, config.leverage);
      console.log(`[Straddle] Unwound Call leg status: ${unwindResult.success ? 'SUCCESS' : 'FAILED'}`);

      if (notifier) {
        void notifier.notifyEntryAborted({
          reason: errorMsg,
          callSuccess: true,
          putSuccess: false,
          unwoundLeg: legs.callSymbol,
        });
      }

      return {
        executedAt: new Date(),
        success: false,
        partialFailure: true,
        atmStrike: legs.atmStrike,
        spotPrice: legs.spotPrice,
        callOutcome,
        putOutcome,
        message: errorMsg,
        unwoundLeg: legs.callSymbol,
      };
    }

    // Case 3: Put filled, Call did NOT fill -> cancel Call, immediately unwind Put
    if (!callFilled && putFilled) {
      const errorMsg = `Partial fill timeout: Put filled (${legs.putSymbol}) but Call timed out unfilled (${legs.callSymbol}). Cancelling Call and unwinding Put immediately.`;
      console.error(`[Straddle] 🚨 ${errorMsg}`);
      appendAlert('partial_fill_timeout', errorMsg);

      if (callOutcome.orderId) {
        await client.cancelOptionsOrder(callOutcome.orderId, legs.callSymbol);
      }
      const unwindResult = await client.closePosition(legs.putSymbol, config.orderQuantity, config.leverage);
      console.log(`[Straddle] Unwound Put leg status: ${unwindResult.success ? 'SUCCESS' : 'FAILED'}`);

      if (notifier) {
        void notifier.notifyEntryAborted({
          reason: errorMsg,
          callSuccess: false,
          putSuccess: true,
          unwoundLeg: legs.putSymbol,
        });
      }

      return {
        executedAt: new Date(),
        success: false,
        partialFailure: true,
        atmStrike: legs.atmStrike,
        spotPrice: legs.spotPrice,
        callOutcome,
        putOutcome,
        message: errorMsg,
        unwoundLeg: legs.putSymbol,
      };
    }
  }

  // Scenario D: Both legs succeeded and confirmed filled
  console.log('[Straddle] ✅ Both legs placed & filled successfully! Initializing risk management...');
  try {
    const state = await initializeStraddleState(callOutcome, putOutcome, client, config, undefined, undefined, todayStr);
    
    // Persist initial state
    await saveStraddleState(state, todayStr);

    if (notifier) {
      void notifier.notifyStraddleEntered({
        strike: legs.atmStrike,
        callSymbol: state.callLeg.symbol,
        callPrice: state.callLeg.entryPrice,
        callPriceSource: state.callLeg.entryPriceSource,
        putSymbol: state.putLeg.symbol,
        putPrice: state.putLeg.entryPrice,
        putPriceSource: state.putLeg.entryPriceSource,
        totalCredit: state.totalCreditReceived,
        callSL: state.callLeg.stopLossPrice,
        putSL: state.putLeg.stopLossPrice,
        targetProfit: state.targetProfitPoints,
      });
    }

    void monitorStraddleRisk(client, state, config, notifier);

    return {
      executedAt: new Date(),
      success: true,
      partialFailure: false,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message: 'Straddle entered and risk monitoring active',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Straddle] ❌ Error initializing straddle state: ${msg}`);

    // CRITICAL: both legs were SOLD successfully, so we are short and — because
    // state init failed — completely unmonitored. Leaving them open would be a
    // naked, unwatched straddle. Unwind both legs immediately.
    console.error('[Straddle] 🚨 Unwinding both filled legs (state init failed after entry)');
    const unwound: string[] = [];
    const unwindFailed: string[] = [];
    for (const symbol of [legs.callSymbol, legs.putSymbol]) {
      try {
        const unwind = await client.closePosition(symbol, config.orderQuantity, config.leverage);
        if (unwind.success) {
          unwound.push(symbol);
          console.log(`[Straddle] ✅ Unwound ${symbol}`);
        } else {
          unwindFailed.push(symbol);
          console.error(`[Straddle] ❌ Unwind failed for ${symbol}: ${unwind.message ?? 'unknown'}`);
        }
      } catch (unwindErr) {
        const uMsg = unwindErr instanceof Error ? unwindErr.message : String(unwindErr);
        unwindFailed.push(symbol);
        console.error(`[Straddle] ❌ Unwind threw for ${symbol}: ${uMsg}`);
      }
    }

    if (notifier) {
      void notifier.notifyError('initializeStraddleState', err);
      void notifier.notifyEntryAborted({
        reason:
          `State initialization failed AFTER both legs filled: ${msg}. ` +
          `Unwound: ${unwound.join(', ') || 'none'}. ` +
          `${unwindFailed.length ? `⚠️ STILL OPEN — MANUAL ACTION NEEDED: ${unwindFailed.join(', ')}` : ''}`,
        callSuccess: true,
        putSuccess: true,
      });
    }

    return {
      executedAt: new Date(),
      success: false,
      partialFailure: true,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message:
        `State initialization failed: ${msg}. Unwound ${unwound.length}/2 legs` +
        `${unwindFailed.length ? ` — STILL OPEN: ${unwindFailed.join(', ')}` : ''}`,
    };
  }
}

function logOutcome(legName: string, outcome: OrderPlacementOutcome): void {
  if (outcome.success) {
    console.log(
      `[Straddle] ✅ ${legName} Sell order placed successfully! Order ID: ${outcome.orderId || 'N/A'}`
    );
  } else {
    console.error(
      `[Straddle] ❌ ${legName} Sell order failed: ${outcome.message || 'Unknown reason'}`
    );
  }
}

/**
 * Checks whether an order outcome indicates an immediate or recorded fill.
 */
export function isOutcomeFilled(outcome: OrderPlacementOutcome): boolean {
  if (!outcome.success) return false;
  const raw = outcome.rawResponse;
  if (!raw || typeof raw !== 'object') return false;

  const status = String(raw.status ?? raw.order_status ?? raw.state ?? '').toLowerCase();
  if (status === 'filled' || status === 'completed' || status === 'closed') {
    return true;
  }

  // Check data sub-object if present
  if (raw.data && typeof raw.data === 'object') {
    const dataObj = raw.data as Record<string, unknown>;
    const dataStatus = String(dataObj.status ?? dataObj.order_status ?? dataObj.state ?? '').toLowerCase();
    if (dataStatus === 'filled' || dataStatus === 'completed' || dataStatus === 'closed') {
      return true;
    }
    const executedQty = Number(dataObj.filled_qty ?? dataObj.executed_qty ?? dataObj.filled_quantity);
    if (Number.isFinite(executedQty) && executedQty > 0) {
      return true;
    }
  }

  const executedQty = Number(raw.filled_qty ?? raw.executed_qty ?? raw.filled_quantity);
  if (Number.isFinite(executedQty) && executedQty > 0) {
    return true;
  }

  return false;
}

/**
 * Checks open orders list from GET /api/v1/options/orders to see if an order is still open.
 * If the order ID is not present in open orders, or if status indicates filled, it is considered filled.
 */
export function checkOrderFilledFromList(
  orderId: string | undefined,
  symbol: string,
  openOrders: readonly Record<string, unknown>[]
): boolean {
  if (!orderId) {
    // If we have no orderId, match by symbol in open orders
    const match = openOrders.find((o) => o.symbol === symbol || o.pair === symbol);
    // If it's in open orders, it is still open (not filled)
    return !match;
  }

  const found = openOrders.find(
    (o) =>
      String(o.id ?? o.order_id ?? o.orderId) === String(orderId) ||
      (o.data && typeof o.data === 'object' && String((o.data as Record<string, unknown>).id ?? (o.data as Record<string, unknown>).order_id) === String(orderId))
  );

  // If found in open orders, check if marked filled or has executed qty
  if (found) {
    const status = String(found.status ?? found.order_status ?? found.state ?? '').toLowerCase();
    if (status === 'filled' || status === 'completed' || status === 'closed') {
      return true;
    }
    const remainingQty = Number(found.remaining_qty ?? found.open_qty ?? found.open_quantity);
    if (Number.isFinite(remainingQty) && remainingQty === 0) {
      return true;
    }
    return false; // Still active/open in orderbook
  }

  // Not found in open orders -> fill has been executed
  return true;
}

/**
 * Polls GET /api/v1/options/orders until both legs are filled or until timeout.
 */
export async function waitForFills(
  client: CoinDCXClient,
  callSymbol: string,
  putSymbol: string,
  callOutcome: OrderPlacementOutcome,
  putOutcome: OrderPlacementOutcome,
  timeoutMs = 15000,
  intervalMs = 1000
): Promise<{ callFilled: boolean; putFilled: boolean }> {
  let callFilled = isOutcomeFilled(callOutcome);
  let putFilled = isOutcomeFilled(putOutcome);

  if (callFilled && putFilled) {
    return { callFilled: true, putFilled: true };
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const openOrders = await client.getOpenOptionsOrders();

      if (!callFilled) {
        callFilled = checkOrderFilledFromList(callOutcome.orderId, callSymbol, openOrders);
      }
      if (!putFilled) {
        putFilled = checkOrderFilledFromList(putOutcome.orderId, putSymbol, openOrders);
      }

      if (callFilled && putFilled) {
        console.log('[Straddle] ✅ Both Call and Put limit orders confirmed filled!');
        return { callFilled: true, putFilled: true };
      }
    } catch (err) {
      console.warn(`[Straddle] Error checking open orders during fill confirmation: ${(err as Error).message}`);
    }

    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  return { callFilled, putFilled };
}

