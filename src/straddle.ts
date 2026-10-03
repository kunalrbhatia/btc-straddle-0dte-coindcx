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
  const [callMark, putMark] = await Promise.all([
    client.getContractPrice(legs.callSymbol),
    client.getContractPrice(legs.putSymbol),
  ]);
  const callListed = Number.isFinite(callMark) && callMark > 0;
  const putListed = Number.isFinite(putMark) && putMark > 0;

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
    `[Straddle] Pre-flight OK       : CALL $${callMark.toFixed(2)} · PUT $${putMark.toFixed(2)}`
  );

  // Step 2: Build Sell Order for Call Leg
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

  // Step 3: Build Sell Order for Put Leg
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
    config.bearerToken
      ? await Promise.all([
          client.placeOptionsOrder(
            legs.callSymbol,
            'sell',
            config.orderQuantity,
            'Market',
            undefined,
            config.conversionRate
          ),
          client.placeOptionsOrder(
            legs.putSymbol,
            'sell',
            config.orderQuantity,
            'Market',
            undefined,
            config.conversionRate
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
  // Scenario A: Both legs failed
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

  // Scenario B: Partial Failure - Call succeeded, Put failed
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

  // Scenario C: Partial Failure - Put succeeded, Call failed
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

  // Scenario D: Both legs succeeded
  console.log('[Straddle] ✅ Both legs placed successfully! Initializing risk management...');
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
    if (notifier) {
      void notifier.notifyError('initializeStraddleState', err);
    }
    return {
      executedAt: new Date(),
      success: false,
      partialFailure: false,
      atmStrike: legs.atmStrike,
      spotPrice: legs.spotPrice,
      callOutcome,
      putOutcome,
      message: `State initialization failed: ${msg}`,
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
