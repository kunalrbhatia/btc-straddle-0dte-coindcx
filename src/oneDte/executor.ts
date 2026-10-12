import { CoinDCXClient } from '../client';
import { TelegramNotifier } from '../notifier';
import { appendAlert } from '../fileAlerter';
import { OneDteConfig } from './config';
import { selectOneDteContracts } from './selector';
import { OneDtePositionState, OneDteLeg } from './types';
import { saveOneDteState } from './stateStore';
import { getTodayDateStringIST } from '../stateStore';

/**
 * Snap a limit price to the venue's tick. FLOOR, not nearest: as the seller we want a *marketable* ask
 * so both legs fill and the strangle is complete. Rounding up (129.44 -> 130) leaves the sell resting
 * above the market, and an unfilled leg leaves the other side short on its own — verified live on
 * 2026-10-12: a 105 limit rested unfilled while a 100 limit crossed and filled at 105.
 * Note: reconciliation.ts has its own `roundToTickSize` which rounds to NEAREST (acceptance D7) — that
 * one aligns stop prices while this one prices the entry, so the two intentionally differ.
 */
export const roundToTick = (price: number, tick: number): number => {
  const t = Number.isFinite(tick) && tick > 0 ? tick : 5;
  return Math.floor(price / t) * t;
};

export async function buyBackFilledLeg(
  client: CoinDCXClient,
  symbol: string,
  quantity: number,
  maxAttempts = 3,
  notifier?: TelegramNotifier
): Promise<boolean> {
  console.warn(`[1DTE Execution] 🚨 Half-filled strangle detected! Initiating immediate buy-back for ${symbol}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[1DTE Execution] Buy-back attempt ${attempt}/${maxAttempts} for ${symbol} (qty: ${quantity}, reduceOnly: true)...`);
      const res = await client.placeOptionsOrder(
        symbol,
        'buy',
        quantity,
        'Market',
        undefined,
        '',
        '',
        undefined,
        true
      );

      if (res.success) {
        console.log(`[1DTE Execution] ✅ Buy-back order placed for ${symbol} (order ID: ${res.orderId}). Verifying flat position...`);
      } else {
        console.error(`[1DTE Execution] ❌ Buy-back order rejected on attempt ${attempt} for ${symbol}: ${res.message}`);
      }
    } catch (err) {
      console.error(`[1DTE Execution] ❌ Exception during buy-back attempt ${attempt} for ${symbol}: ${(err as Error).message}`);
    }

    // Verify whether position is flat
    try {
      const positions = await client.getOptionsPositions();
      const stillOpen = positions.some((p) => {
        if (p.symbol !== symbol) return false;
        const raw = p as Record<string, unknown>;
        const pv = Number(raw.positionValue);
        if (Number.isFinite(pv)) return pv !== 0;
        const q = Number(raw.qty ?? raw.quantity);
        if (Number.isFinite(q)) return q !== 0;
        return true;
      });

      if (!stillOpen) {
        console.log(`[1DTE Execution] ✅ Verified flat book: ${symbol} is closed.`);
        return true;
      }
      console.warn(`[1DTE Execution] ⚠️ ${symbol} still reported open on attempt ${attempt}.`);
    } catch (posErr) {
      console.warn(`[1DTE Execution] ⚠️ Failed to query positions after attempt ${attempt}: ${(posErr as Error).message}`);
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // If still not flat after maxAttempts, raise loud deduped alert
  const alertMsg = `CRITICAL: Half-filled leg ${symbol} buy-back FAILED after ${maxAttempts} attempts. Position may be open naked!`;
  console.error(`[1DTE Execution] 🚨 ${alertMsg}`);
  appendAlert('onedte_unhedged_leg', alertMsg, { symbol, quantity }, { dedupKey: `unhedged_${symbol}` });
  if (notifier) {
    void notifier.notifyError(`CRITICAL: Unhedged 1 DTE Leg (${symbol})`, new Error(alertMsg));
  }

  return false;
}

export async function executeOneDteEntry(
  client: CoinDCXClient,
  config: OneDteConfig,
  notifier?: TelegramNotifier
): Promise<OneDtePositionState | null> {
  console.log('\n[1DTE Execution] 🚀 Discovering and selecting 1 DTE contracts...');
  const contracts = await selectOneDteContracts(client, config);
  if (!contracts) {
    const errMsg = '1 DTE contract discovery failed — skipping execution.';
    console.error(`[1DTE Execution] ❌ ${errMsg}`);
    if (notifier) void notifier.notifyError('1 DTE Discovery Failed', new Error(errMsg));
    return null;
  }

  const { call, put, expiryTimeMs } = contracts;

  console.log(`[1DTE Execution] Call: ${call.symbol} (indicative: $${call.premium.toFixed(2)})`);
  console.log(`[1DTE Execution] Put : ${put.symbol} (indicative: $${put.premium.toFixed(2)})`);

  // Calculate target exit time: next day at config.exitHourIST:config.exitMinuteIST IST
  const now = new Date();
  const istOffsetMs = 330 * 60 * 1000;
  const nowIst = new Date(now.getTime() + istOffsetMs);
  // Next day IST
  const nextDayIstYear = nowIst.getUTCFullYear();
  const nextDayIstMonth = nowIst.getUTCMonth();
  const nextDayIstDate = nowIst.getUTCDate() + 1;

  const targetExitIstMs = Date.UTC(
    nextDayIstYear,
    nextDayIstMonth,
    nextDayIstDate,
    config.exitHourIST,
    config.exitMinuteIST,
    0,
    0
  );
  const targetExitUtcMs = targetExitIstMs - istOffsetMs;

  console.log(
    `[1DTE Execution] Target scheduled exit: ${new Date(targetExitUtcMs).toISOString()} (${config.exitHourIST}:${String(config.exitMinuteIST).padStart(2, '0')} IST next day)`
  );

  // Compute entry limit prices and protective stopLoss triggers
  const callLimitPrice = config.entryOrderType === 'Limit' ? roundToTick(call.premium, config.priceTick) : undefined;
  const putLimitPrice = config.entryOrderType === 'Limit' ? roundToTick(put.premium, config.priceTick) : undefined;

  const callBasePrice = callLimitPrice ?? call.premium;
  const putBasePrice = putLimitPrice ?? put.premium;

  const callStopLoss = Math.round(callBasePrice * config.stopLossMultiplier);
  const putStopLoss = Math.round(putBasePrice * config.stopLossMultiplier);

  // Place Sell Orders with protective stopLoss armed on the opening SELL
  console.log(
    `[1DTE Execution] Placing SELL orders for ${call.symbol} (price: ${callLimitPrice ?? 'Market'}, SL: ${callStopLoss}) and ${put.symbol} (price: ${putLimitPrice ?? 'Market'}, SL: ${putStopLoss})...`
  );
  const [callOrder, putOrder] = await Promise.all([
    client.placeOptionsOrder(
      call.symbol,
      'sell',
      config.orderQuantity,
      config.entryOrderType,
      callLimitPrice,
      String(callStopLoss),
      '',
      undefined,
      false
    ),
    client.placeOptionsOrder(
      put.symbol,
      'sell',
      config.orderQuantity,
      config.entryOrderType,
      putLimitPrice,
      String(putStopLoss),
      '',
      undefined,
      false
    ),
  ]);

  const todayStr = getTodayDateStringIST();

  // Case 1: Both legs failed
  if (!callOrder.success && !putOrder.success) {
    const failureReason = `Both legs failed: Call=${callOrder.message || 'unknown'}, Put=${putOrder.message || 'unknown'}`;
    console.error(`[1DTE Execution] 🚨 ${failureReason}`);
    const failedState: OneDtePositionState = {
      date: todayStr,
      expiryTimeMs,
      entryExecuted: false,
      targetExitUtcMs,
      callLeg: {
        legType: 'CALL',
        symbol: call.symbol,
        strikePrice: call.strikePrice,
        entryPrice: callBasePrice,
        stopLossPrice: callStopLoss,
        quantity: config.orderQuantity,
        orderId: callOrder.orderId,
        status: 'closed',
        currentPrice: callBasePrice,
      },
      putLeg: {
        legType: 'PUT',
        symbol: put.symbol,
        strikePrice: put.strikePrice,
        entryPrice: putBasePrice,
        stopLossPrice: putStopLoss,
        quantity: config.orderQuantity,
        orderId: putOrder.orderId,
        status: 'closed',
        currentPrice: putBasePrice,
      },
      totalCreditReceived: 0,
      combinedPnLPoints: 0,
      status: 'closed',
      failureReason,
    };
    await saveOneDteState(failedState, todayStr);
    console.log(`[1DTE Execution] Persisted failed entry state with entryExecuted: false to state/onedte-state-${todayStr}.json`);
    if (notifier) {
      void notifier.notifyError('1 DTE Entry Failed (Both Legs)', new Error(failureReason));
    }
    return null;
  }

  // Case 2: Partial fill (Call succeeded, Put failed)
  if (callOrder.success && !putOrder.success) {
    const failureReason = `Partial fill: Call succeeded (${callOrder.orderId}), but Put failed (${putOrder.message || 'unknown'})`;
    console.error(`[1DTE Execution] 🚨 ${failureReason}`);
    await buyBackFilledLeg(client, call.symbol, config.orderQuantity, 3, notifier);

    const abortedState: OneDtePositionState = {
      date: todayStr,
      expiryTimeMs,
      entryExecuted: false,
      targetExitUtcMs,
      callLeg: {
        legType: 'CALL',
        symbol: call.symbol,
        strikePrice: call.strikePrice,
        entryPrice: callOrder.limitPrice ?? callBasePrice,
        stopLossPrice: callStopLoss,
        quantity: config.orderQuantity,
        orderId: callOrder.orderId,
        status: 'closed',
        currentPrice: callOrder.limitPrice ?? callBasePrice,
      },
      putLeg: {
        legType: 'PUT',
        symbol: put.symbol,
        strikePrice: put.strikePrice,
        entryPrice: putBasePrice,
        stopLossPrice: putStopLoss,
        quantity: config.orderQuantity,
        orderId: putOrder.orderId,
        status: 'closed',
        currentPrice: putBasePrice,
      },
      totalCreditReceived: 0,
      combinedPnLPoints: 0,
      status: 'closed',
      failureReason,
    };
    await saveOneDteState(abortedState, todayStr);
    console.log(`[1DTE Execution] Persisted aborted partial fill state with entryExecuted: false to state/onedte-state-${todayStr}.json`);
    if (notifier) {
      void notifier.notifyError('1 DTE Entry Aborted (Partial Fill)', new Error(failureReason));
    }
    return null;
  }

  // Case 2: Partial fill (Put succeeded, Call failed)
  if (!callOrder.success && putOrder.success) {
    const failureReason = `Partial fill: Put succeeded (${putOrder.orderId}), but Call failed (${callOrder.message || 'unknown'})`;
    console.error(`[1DTE Execution] 🚨 ${failureReason}`);
    await buyBackFilledLeg(client, put.symbol, config.orderQuantity, 3, notifier);

    const abortedState: OneDtePositionState = {
      date: todayStr,
      expiryTimeMs,
      entryExecuted: false,
      targetExitUtcMs,
      callLeg: {
        legType: 'CALL',
        symbol: call.symbol,
        strikePrice: call.strikePrice,
        entryPrice: callBasePrice,
        stopLossPrice: callStopLoss,
        quantity: config.orderQuantity,
        orderId: callOrder.orderId,
        status: 'closed',
        currentPrice: callBasePrice,
      },
      putLeg: {
        legType: 'PUT',
        symbol: put.symbol,
        strikePrice: put.strikePrice,
        entryPrice: putOrder.limitPrice ?? putBasePrice,
        stopLossPrice: putStopLoss,
        quantity: config.orderQuantity,
        orderId: putOrder.orderId,
        status: 'closed',
        currentPrice: putOrder.limitPrice ?? putBasePrice,
      },
      totalCreditReceived: 0,
      combinedPnLPoints: 0,
      status: 'closed',
      failureReason,
    };
    await saveOneDteState(abortedState, todayStr);
    console.log(`[1DTE Execution] Persisted aborted partial fill state with entryExecuted: false to state/onedte-state-${todayStr}.json`);
    if (notifier) {
      void notifier.notifyError('1 DTE Entry Aborted (Partial Fill)', new Error(failureReason));
    }
    return null;
  }

  // Case 3: Both legs succeeded!
  const callEntry = callOrder.limitPrice ?? callBasePrice;
  const putEntry = putOrder.limitPrice ?? putBasePrice;

  console.log(`[1DTE Execution] Call entry: $${callEntry.toFixed(2)}, SL trigger: $${callStopLoss}`);
  console.log(`[1DTE Execution] Put entry : $${putEntry.toFixed(2)}, SL trigger: $${putStopLoss}`);

  const callLeg: OneDteLeg = {
    legType: 'CALL',
    symbol: call.symbol,
    strikePrice: call.strikePrice,
    entryPrice: callEntry,
    stopLossPrice: callStopLoss,
    quantity: config.orderQuantity,
    orderId: callOrder.orderId,
    status: 'open',
    currentPrice: callEntry,
  };

  const putLeg: OneDteLeg = {
    legType: 'PUT',
    symbol: put.symbol,
    strikePrice: put.strikePrice,
    entryPrice: putEntry,
    stopLossPrice: putStopLoss,
    quantity: config.orderQuantity,
    orderId: putOrder.orderId,
    status: 'open',
    currentPrice: putEntry,
  };

  const state: OneDtePositionState = {
    date: todayStr,
    expiryTimeMs,
    entryExecuted: true,
    targetExitUtcMs,
    callLeg,
    putLeg,
    totalCreditReceived: callEntry + putEntry,
    combinedPnLPoints: 0,
    status: 'active',
  };

  await saveOneDteState(state, todayStr);
  console.log(`[1DTE Execution] State successfully persisted to state/onedte-state-${todayStr}.json`);

  if (notifier) {
    void notifier.notifyStraddleEntered({
      strike: Math.round((call.strikePrice + put.strikePrice) / 2),
      callSymbol: call.symbol,
      callPrice: callEntry,
      callPriceSource: 'fill',
      putSymbol: put.symbol,
      putPrice: putEntry,
      putPriceSource: 'fill',
      totalCredit: callEntry + putEntry,
      callSL: callStopLoss,
      putSL: putStopLoss,
      targetProfit: 0,
    });
  }

  return state;
}

