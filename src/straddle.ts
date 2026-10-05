import { CoinDCXClient } from './client';
import {
  OrderItem,
  OrderPlacementOutcome,
  OptionsInstrument,
  StraddleExecutionResult,
  StraddleLegs,
} from './types';
import { AppConfig, config } from './config';
import { initializeStraddleState, monitorStraddleRisk } from './riskManager';
import { Notifier } from './notifier';
import { getTodayDateStringIST, saveStraddleState } from './stateStore';
import { appendAlert } from './fileAlerter';
import { classifyExitError } from './reconciliation';

export interface PlacementRetryOptions {
  /** Total attempts including the first one. Default 3. */
  readonly maxAttempts?: number;
  /** Backoff base: attempt N waits base * N ms. Default 2000. */
  readonly baseDelayMs?: number;
  /** Injectable sleep so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Places ONE leg, retrying only *transient* rejections.
 *
 * Why this exists: on 2026-10-05 a single exchange-side refusal cost the whole trading day. The
 * entry placed both legs once, both came back `400 OCS-TECH-0024 "Failed to place the order.
 * Please retry."`, and the cycle was abandoned — while the exit path has retried the same
 * signature three times with backoff all along. The venue's own message asks for a retry; the
 * entry should honour that.
 *
 * Deliberately narrow: a *permanent* rejection (unknown contract, bad quantity, insufficient
 * margin, precision) is returned immediately and never retried, so real failures stay loud and
 * fast — and, critically, so a doomed order is never re-sent a leg at a time.
 */
export async function placeLegWithRetry(
  place: () => Promise<OrderPlacementOutcome>,
  options: PlacementRetryOptions = {}
): Promise<OrderPlacementOutcome> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: OrderPlacementOutcome | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await place();
    if (last.success) {
      if (attempt > 1) {
        console.log(`[Straddle] ✅ ${last.symbol} accepted on attempt ${attempt}/${maxAttempts} (after transient rejection).`);
      }
      return last;
    }

    const { isPermanent, category } = classifyExitError(
      last.message ?? '',
      last.rawResponse as Record<string, unknown> | undefined
    );

    if (isPermanent) {
      console.warn(`[Straddle] ⛔ ${last.symbol} rejected permanently (${category}) — not retrying.`);
      return last;
    }

    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * attempt;
      console.warn(
        `[Straddle] ⏳ ${last.symbol} transient rejection (${category}) — retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms.`
      );
      await sleep(delayMs);
    }
  }

  // All attempts exhausted and still transient-failing.
  return last as OrderPlacementOutcome;
}

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
 * Used as a fallback when public instruments discovery is unavailable.
 */
/** The expiry date of the contract that is actually tradeable right now. */
export function nextExpiryDate(
  now = new Date(),
  expiryHourUtc = config?.dailyExpiryHourUTC ?? 8
): Date {
  const todaysExpiryMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    expiryHourUtc,
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
 * Used as fallback arithmetic when instrument discovery is unavailable.
 * e.g. BTC-4OCT26-84750-C-USDT / BTC-4OCT26-84750-P-USDT
 */
export function generateContractSymbols(
  atmStrike: number,
  targetDate = new Date(),
  expiryHourUtc = config?.dailyExpiryHourUTC ?? 8
): { readonly callSymbol: string; readonly putSymbol: string } {
  const expiry = nextExpiryDate(targetDate, expiryHourUtc);
  const day = expiry.getUTCDate();
  const month = MONTH_NAMES[expiry.getUTCMonth()];
  const yy = String(expiry.getUTCFullYear()).slice(-2);
  const expiryStr = `${day}${month}${yy}`;

  const callSymbol = `BTC-${expiryStr}-${atmStrike}-C-USDT`;
  const putSymbol = `BTC-${expiryStr}-${atmStrike}-P-USDT`;

  return { callSymbol, putSymbol };
}

/**
 * Discovers ATM straddle legs directly from CoinDCX's public options instruments list.
 *
 * Algorithm:
 * 1. Filter for isActive === true and valid numeric expiryTimeMs.
 * 2. Filter for expiryTimeMs >= nowMs + minLeadMinutes (reject contracts expiring too soon).
 * 3. Group by expiryTimeMs and pick the earliest valid expiryTimeMs.
 * 4. Among instruments of that expiry, identify available strike prices.
 * 5. Pick the strike closest to spot on the strikeStep grid (or closest listed strike).
 * 6. Extract exact call and put symbols verbatim from the API.
 *
 * Returns null if no eligible instruments are found.
 */
export function discoverAtmStraddleFromInstruments(
  instruments: readonly OptionsInstrument[],
  spotPrice: number,
  strikeStep: number,
  now = new Date(),
  minLeadMinutes = 30
): StraddleLegs | null {
  const nowMs = now.getTime();
  const minLeadMs = minLeadMinutes * 60 * 1000;

  // 1 & 2: Active instruments with at least minLeadMinutes lead time
  const valid = instruments.filter((inst) => {
    if (!inst.isActive) return false;
    const expMs = Number(inst.expiryTime);
    return Number.isFinite(expMs) && expMs >= nowMs + minLeadMs;
  });

  if (valid.length === 0) {
    return null;
  }

  // 3. Find earliest future expiry
  const allExpiries = Array.from(new Set(valid.map((inst) => Number(inst.expiryTime)))).sort((a, b) => a - b);
  const targetExpiryMs = allExpiries[0];

  const expiryInstruments = valid.filter((inst) => Number(inst.expiryTime) === targetExpiryMs);

  // 4. Identify available strikes with both Call and Put available
  const callMap = new Map<number, string>();
  const putMap = new Map<number, string>();

  for (const inst of expiryInstruments) {
    const strike = Number(inst.strikePrice);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const optType = String(inst.optionsType || '').toLowerCase();
    const symbol = inst.symbol || inst.displayName;
    if (!symbol) continue;

    if (optType === 'call') {
      callMap.set(strike, symbol);
    } else if (optType === 'put') {
      putMap.set(strike, symbol);
    }
  }

  // Complete pairs available
  const completeStrikes = Array.from(callMap.keys()).filter((s) => putMap.has(s));
  if (completeStrikes.length === 0) {
    return null;
  }

  // 5. Select strike closest to spot rounded to strikeStep
  const idealAtm = calculateAtmStrike(spotPrice, strikeStep);

  // If idealAtm is listed, pick it; otherwise pick nearest available listed strike
  completeStrikes.sort((a, b) => Math.abs(a - idealAtm) - Math.abs(b - idealAtm) || Math.abs(a - spotPrice) - Math.abs(b - spotPrice));
  const chosenStrike = completeStrikes[0];

  const callSymbol = callMap.get(chosenStrike)!;
  const putSymbol = putMap.get(chosenStrike)!;

  return {
    spotPrice,
    atmStrike: chosenStrike,
    callSymbol,
    putSymbol,
    expiryTimeMs: targetExpiryMs,
  };
}

/**
 * Determines ATM straddle legs based on live BTC spot price or custom overrides.
 *
 * Primary discovery: queries the public instruments endpoint to discover the actual
 * listed expiry and verbatim symbols from the exchange.
 *
 * Fallback: if instruments cannot be read or no valid future expiry exists,
 * logs a loud warning and falls back to arithmetic symbol generation.
 */
export async function determineAtmStraddle(
  client: CoinDCXClient,
  config: AppConfig
): Promise<StraddleLegs> {
  const spotPrice = await client.getBtcSpotPrice();
  const atmStrike = calculateAtmStrike(spotPrice, config.strikeStep);

  let discovered: StraddleLegs | null = null;
  try {
    const instruments = await client.getOptionsInstruments('BTC');
    if (instruments && instruments.length > 0) {
      discovered = discoverAtmStraddleFromInstruments(
        instruments,
        spotPrice,
        config.strikeStep,
        new Date(),
        config.expiryMinLeadMinutes ?? 30
      );
    }
  } catch (err) {
    console.warn(
      `[Straddle] ⚠️ Failed to fetch options instruments from exchange: ${(err as Error).message}`
    );
  }

  let finalCallSymbol: string;
  let finalPutSymbol: string;
  let finalStrike = atmStrike;
  let finalExpiryTimeMs: number | undefined;

  if (discovered) {
    console.log(
      `[Straddle] 🔍 Discovered live expiry from exchange: ${new Date(discovered.expiryTimeMs!).toISOString()} (CALL: ${discovered.callSymbol}, PUT: ${discovered.putSymbol})`
    );
    finalCallSymbol = discovered.callSymbol;
    finalPutSymbol = discovered.putSymbol;
    finalStrike = discovered.atmStrike;
    finalExpiryTimeMs = discovered.expiryTimeMs;
  } else {
    // Fallback path: log loudly that fallback was used
    console.warn(
      `[Straddle] ⚠️ Could not discover instruments from exchange API — falling back to arithmetic DAILY_EXPIRY_HOUR_UTC (${config.dailyExpiryHourUTC}) calculation!`
    );
    const fallback = generateContractSymbols(atmStrike, new Date(), config.dailyExpiryHourUTC);
    finalCallSymbol = fallback.callSymbol;
    finalPutSymbol = fallback.putSymbol;
    finalExpiryTimeMs = nextExpiryDate(new Date(), config.dailyExpiryHourUTC).getTime();
  }

  const callSymbol = config.customCallSymbol || finalCallSymbol;
  const putSymbol = config.customPutSymbol || finalPutSymbol;

  return {
    spotPrice,
    atmStrike: finalStrike,
    callSymbol,
    putSymbol,
    expiryTimeMs: finalExpiryTimeMs,
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
    const expiryTimeMs = legs.expiryTimeMs ?? nextExpiryDate(new Date(), config.dailyExpiryHourUTC).getTime();

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
          // Each leg is retried on transient rejections only (see placeLegWithRetry) — a single
          // "Please retry." from the venue must not cost the whole day's trade.
          placeLegWithRetry(() =>
            client.placeOptionsOrder(
              legs.callSymbol,
              'sell',
              config.orderQuantity,
              config.entryOrderType,
              callPrice,
              callStopLoss,
              ''
            )
          ),
          placeLegWithRetry(() =>
            client.placeOptionsOrder(
              legs.putSymbol,
              'sell',
              config.orderQuantity,
              config.entryOrderType,
              putPrice,
              putStopLoss,
              ''
            )
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

