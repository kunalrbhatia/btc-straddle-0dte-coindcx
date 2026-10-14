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

export const entryLimitFromBid = (bid: number, tick: number): number => {
  return roundToTick(bid, tick);
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

type PositionRows = Awaited<ReturnType<CoinDCXClient['getOptionsPositions']>>;

/** A leg counts as filled only when the venue shows a position for it — and it reports the fill price. */
function readLegFill(positions: PositionRows, symbol: string): { filled: boolean; price?: number } {
  const row = (positions as unknown as Array<Record<string, unknown>>).find((p) => String(p.symbol) === symbol);
  if (!row) return { filled: false };
  const pv = Number(row.positionValue);
  if (Number.isFinite(pv)) {
    if (pv === 0) return { filled: false };
  } else {
    const q = Number(row.qty ?? row.quantity);
    if (Number.isFinite(q) && q === 0) return { filled: false };
  }
  const avg = Number(row.avgPrice);
  return { filled: true, price: Number.isFinite(avg) ? avg : undefined };
}

export interface FillCheck {
  callFilled: boolean;
  putFilled: boolean;
  callFillPrice?: number;
  putFillPrice?: number;
}

/**
 * Polls the venue's positions until both legs are genuinely open, or the timeout expires.
 *
 * An order being ACCEPTED is not the same as it being FILLED: a limit priced above the market is accepted
 * and then rests. That is not hypothetical — on 2026-10-12 the CALL sell rested unfilled while the PUT
 * filled, which left a one-sided short until a deeper limit crossed. Returns the venue's own fill prices
 * so the record reflects the fill, not the quote.
 */
export async function verifyFillsByPosition(
  client: CoinDCXClient,
  callSymbol: string,
  putSymbol: string,
  timeoutMs: number,
  intervalMs = 2000
): Promise<FillCheck> {
  const start = Date.now();
  let last: FillCheck = { callFilled: false, putFilled: false };
  for (;;) {
    try {
      const positions = await client.getOptionsPositions();
      const c = readLegFill(positions, callSymbol);
      const p = readLegFill(positions, putSymbol);
      last = { callFilled: c.filled, putFilled: p.filled, callFillPrice: c.price, putFillPrice: p.price };
      if (last.callFilled && last.putFilled) return last;
    } catch (err) {
      console.warn(`[1DTE Execution] Fill check failed: ${(err as Error).message}`);
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return last;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, timeoutMs - elapsed)));
  }
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

  // 3.6 Refuse to place an unpriceable leg
  if (!call.premium || call.premium <= 0 || !put.premium || put.premium <= 0) {
    const failureReason = `Unpriceable leg detected: Call bid=${call.premium}, Put bid=${put.premium}. Aborting entry before placing anything.`;
    console.error(`[1DTE Execution] 🚨 ${failureReason}`);
    const todayStr = getTodayDateStringIST();
    const abortedState: OneDtePositionState = {
      date: todayStr,
      expiryTimeMs,
      entryExecuted: false,
      targetExitUtcMs,
      callLeg: {
        legType: 'CALL',
        symbol: call.symbol,
        strikePrice: call.strikePrice,
        entryPrice: 0,
        stopLossPrice: 0,
        quantity: config.orderQuantity,
        entryBid: call.premium,
        status: 'closed',
        currentPrice: 0,
      },
      putLeg: {
        legType: 'PUT',
        symbol: put.symbol,
        strikePrice: put.strikePrice,
        entryPrice: 0,
        stopLossPrice: 0,
        quantity: config.orderQuantity,
        entryBid: put.premium,
        status: 'closed',
        currentPrice: 0,
      },
      totalCreditReceived: 0,
      combinedPnLPoints: 0,
      status: 'closed',
      failureReason,
    };
    await saveOneDteState(abortedState, todayStr);
    if (notifier) void notifier.notifyError('1 DTE Entry Aborted (Unpriceable Leg)', new Error(failureReason));
    return null;
  }

  // 3.4 & 3.7 Compute entry limits, SL triggers, and log self-explaining entry lines
  let callLimitPrice = config.entryOrderType === 'Limit' ? roundToTick(call.premium, config.priceTick) : undefined;
  let putLimitPrice = config.entryOrderType === 'Limit' ? roundToTick(put.premium, config.priceTick) : undefined;

  let callBasePrice = callLimitPrice ?? call.premium;
  let putBasePrice = putLimitPrice ?? put.premium;

  let callStopLoss = Math.round(callBasePrice * config.stopLossMultiplier);
  let putStopLoss = Math.round(putBasePrice * config.stopLossMultiplier);

  let currentCallBid = call.premium;
  let currentPutBid = put.premium;

  // Log self-explaining lines
  console.log(
    `[1DTE Entry Diagnostic] CALL: symbol=${call.symbol}, bid=${currentCallBid}, limit=${callLimitPrice ?? 'Market'}, SL=${callStopLoss}`
  );
  console.log(
    `[1DTE Entry Diagnostic] PUT : symbol=${put.symbol}, bid=${currentPutBid}, limit=${putLimitPrice ?? 'Market'}, SL=${putStopLoss}`
  );

  // Place Sell Orders with protective stopLoss armed on the opening SELL
  console.log(
    `[1DTE Execution] Placing SELL orders for ${call.symbol} (price: ${callLimitPrice ?? 'Market'}, SL: ${callStopLoss}) and ${put.symbol} (price: ${putLimitPrice ?? 'Market'}, SL: ${putStopLoss})...`
  );
  let [callOrder, putOrder] = await Promise.all([
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

  // Every order id we have placed for a leg. A re-quote replaces the tracked order, and an order we lose
  // track of is an order we can never cancel — the unwind must be able to reach all of them.
  const placedOrderIds: { CALL: string[]; PUT: string[] } = { CALL: [], PUT: [] };
  if (callOrder.orderId) placedOrderIds.CALL.push(callOrder.orderId);
  if (putOrder.orderId) placedOrderIds.PUT.push(putOrder.orderId);

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
        entryBid: currentCallBid,
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
        entryBid: currentPutBid,
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
        entryBid: currentCallBid,
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
        entryBid: currentPutBid,
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
        entryBid: currentCallBid,
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
        entryBid: currentPutBid,
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

  // Case 3: both orders were ACCEPTED — poll venue positions and re-quote if necessary.
  let callFillPrice: number | undefined;
  let putFillPrice: number | undefined;

  if (config.dryRun) {
    console.log('[1DTE Execution] DRY RUN: skipping venue fill verification.');
  } else {
    const startMs = Date.now();
    const requoteIntervalMs = config.requoteAfterMs;
    const maxRequotes = config.maxRequotes;
    let requotesCount = 0;
    let nextRequoteCheckTime = startMs + requoteIntervalMs;

    let fills: FillCheck = { callFilled: false, putFilled: false };

    while (Date.now() - startMs < config.entryFillTimeoutMs) {
      try {
        const positions = await client.getOptionsPositions();
        const c = readLegFill(positions, call.symbol);
        const p = readLegFill(positions, put.symbol);
        fills = { callFilled: c.filled, putFilled: p.filled, callFillPrice: c.price, putFillPrice: p.price };
        if (fills.callFilled && fills.putFilled) {
          break;
        }
      } catch (err) {
        console.warn(`[1DTE Execution] Position check error: ${(err as Error).message}`);
      }

      // Check if time for requote
      if (Date.now() >= nextRequoteCheckTime && requotesCount < maxRequotes) {
        requotesCount++;
        console.log(`[1DTE Execution] Checking for re-quote (attempt ${requotesCount}/${maxRequotes})...`);

        try {
          // Re-fetch live tickers for updated bids
          const tickers = await client.getOptionsTicker('BTC', expiryTimeMs);

          // Handle CALL leg requote if not filled
          if (!fills.callFilled && callOrder.orderId) {
            console.log(`[1DTE Execution] Re-quoting CALL ${call.symbol}: cancelling resting order ${callOrder.orderId}...`);
            const cancelled = await client.cancelOptionsOrder(callOrder.orderId, call.symbol);
            console.log(`[1DTE Execution] Cancelled CALL order ${callOrder.orderId}: ${cancelled}`);

            if (!cancelled) {
              // A cancel that did NOT succeed leaves the previous order RESTING on the venue. Placing a
              // replacement now would put two live sells on the same leg: if both fill, the intended 0.01
              // short becomes 0.02, and the extra order is one the unwind cannot see. Withhold the
              // replacement and let the unwind pass deal with the order that is still there.
              console.error(
                `[1DTE Execution] 🚨 CALL cancel of ${callOrder.orderId} did NOT succeed — withholding the replacement sell (a second live sell would double the position).`
              );
              appendAlert(
                'onedte_requote_cancel_failed',
                `CALL re-quote cancelled nothing for ${call.symbol} (order ${callOrder.orderId}). Replacement withheld to avoid a double sell.`,
                { symbol: call.symbol, orderId: callOrder.orderId },
                { dedupKey: `requote_cancel_${call.symbol}` }
              );
            } else {
              const callTicker = tickers.find((t) => t.symbol === call.symbol);
              const rawBid = callTicker ? Number(callTicker.bidPrice) : 0;
              if (rawBid > 0) {
                currentCallBid = rawBid;
                callLimitPrice = roundToTick(rawBid, config.priceTick);
                callBasePrice = callLimitPrice;
                callStopLoss = Math.round(callBasePrice * config.stopLossMultiplier);

                console.log(
                  `[1DTE Execution] Re-placing SELL for CALL ${call.symbol} (bid: ${rawBid}, new limit: ${callLimitPrice}, new SL: ${callStopLoss})...`
                );
                callOrder = await client.placeOptionsOrder(
                  call.symbol,
                  'sell',
                  config.orderQuantity,
                  config.entryOrderType,
                  callLimitPrice,
                  String(callStopLoss),
                  '',
                  undefined,
                  false
                );
                if (callOrder.orderId) placedOrderIds.CALL.push(callOrder.orderId);
              } else {
                console.warn(`[1DTE Execution] ⚠️ No valid bid found for CALL ${call.symbol} during re-quote`);
              }
            }
          }

          // Handle PUT leg requote if not filled
          if (!fills.putFilled && putOrder.orderId) {
            console.log(`[1DTE Execution] Re-quoting PUT ${put.symbol}: cancelling resting order ${putOrder.orderId}...`);
            const cancelled = await client.cancelOptionsOrder(putOrder.orderId, put.symbol);
            console.log(`[1DTE Execution] Cancelled PUT order ${putOrder.orderId}: ${cancelled}`);

            if (!cancelled) {
              // Same rule as the CALL leg: never place a second live sell while the first may still be
              // resting on the venue.
              console.error(
                `[1DTE Execution] 🚨 PUT cancel of ${putOrder.orderId} did NOT succeed — withholding the replacement sell (a second live sell would double the position).`
              );
              appendAlert(
                'onedte_requote_cancel_failed',
                `PUT re-quote cancelled nothing for ${put.symbol} (order ${putOrder.orderId}). Replacement withheld to avoid a double sell.`,
                { symbol: put.symbol, orderId: putOrder.orderId },
                { dedupKey: `requote_cancel_${put.symbol}` }
              );
            } else {
              const putTicker = tickers.find((t) => t.symbol === put.symbol);
              const rawBid = putTicker ? Number(putTicker.bidPrice) : 0;
              if (rawBid > 0) {
                currentPutBid = rawBid;
                putLimitPrice = roundToTick(rawBid, config.priceTick);
                putBasePrice = putLimitPrice;
                putStopLoss = Math.round(putBasePrice * config.stopLossMultiplier);

                console.log(
                  `[1DTE Execution] Re-placing SELL for PUT ${put.symbol} (bid: ${rawBid}, new limit: ${putLimitPrice}, new SL: ${putStopLoss})...`
                );
                putOrder = await client.placeOptionsOrder(
                  put.symbol,
                  'sell',
                  config.orderQuantity,
                  config.entryOrderType,
                  putLimitPrice,
                  String(putStopLoss),
                  '',
                  undefined,
                  false
                );
                if (putOrder.orderId) placedOrderIds.PUT.push(putOrder.orderId);
              } else {
                console.warn(`[1DTE Execution] ⚠️ No valid bid found for PUT ${put.symbol} during re-quote`);
              }
            }
          }
        } catch (rqErr) {
          console.warn(`[1DTE Execution] ⚠️ Re-quote attempt ${requotesCount} failed: ${(rqErr as Error).message}`);
        }

        nextRequoteCheckTime = Date.now() + requoteIntervalMs;
      }

      const sleepMs = Math.max(10, Math.min(config.pollIntervalMs, config.requoteAfterMs, 1000));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    // Final position check
    if (!fills.callFilled || !fills.putFilled) {
      try {
        const positions = await client.getOptionsPositions();
        const c = readLegFill(positions, call.symbol);
        const p = readLegFill(positions, put.symbol);
        fills = { callFilled: c.filled, putFilled: p.filled, callFillPrice: c.price, putFillPrice: p.price };
      } catch {}
    }

    if (!fills.callFilled || !fills.putFilled) {
      const missing = [!fills.callFilled ? call.symbol : '', !fills.putFilled ? put.symbol : ''].filter(Boolean).join(', ');
      const failureReason = `Fill verification failed for ${missing}: order accepted but no venue position within ${config.entryFillTimeoutMs}ms.`;
      console.error(`[1DTE Execution] 🚨 ${failureReason}`);

      // Cancel every order we have placed for a leg that did NOT fill — not just the last one — then unwind
      // whichever leg did fill. A re-quote replaces the tracked order, so the earlier ids would otherwise be
      // lost to the unwind; cancelling an id that is already gone is a harmless no-op. A leg that DID fill is
      // left alone (it is unwound below), and the book is never left with a lone side.
      for (const [sym, leg, filled] of [
        [call.symbol, 'CALL', fills.callFilled] as const,
        [put.symbol, 'PUT', fills.putFilled] as const,
      ]) {
        if (filled) continue;
        for (const orderId of placedOrderIds[leg]) {
          try {
            const cancelled = await client.cancelOptionsOrder(orderId, sym);
            console.log(`[1DTE Execution] Cancelled resting order ${orderId} (${sym}): ${cancelled}`);
          } catch (err) {
            console.warn(`[1DTE Execution] Could not cancel ${orderId} (${sym}): ${(err as Error).message}`);
          }
        }
      }
      if (fills.callFilled) await buyBackFilledLeg(client, call.symbol, config.orderQuantity, 3, notifier);
      if (fills.putFilled) await buyBackFilledLeg(client, put.symbol, config.orderQuantity, 3, notifier);

      const unfilledState: OneDtePositionState = {
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
          entryBid: currentCallBid,
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
          entryBid: currentPutBid,
          orderId: putOrder.orderId,
          status: 'closed',
          currentPrice: putBasePrice,
        },
        totalCreditReceived: 0,
        combinedPnLPoints: 0,
        status: 'closed',
        failureReason,
      };
      await saveOneDteState(unfilledState, todayStr);
      console.log(`[1DTE Execution] Persisted aborted unfilled-leg state with entryExecuted: false to state/onedte-state-${todayStr}.json`);
      if (notifier) {
        void notifier.notifyError('1 DTE Entry Aborted (Leg Did Not Fill)', new Error(failureReason));
      }
      return null;
    }

    callFillPrice = fills.callFillPrice;
    putFillPrice = fills.putFillPrice;
  }

  const callEntry = callFillPrice ?? callOrder.limitPrice ?? callBasePrice;
  const putEntry = putFillPrice ?? putOrder.limitPrice ?? putBasePrice;

  console.log(`[1DTE Execution] Call entry: $${callEntry.toFixed(2)}, SL trigger: $${callStopLoss}`);
  console.log(`[1DTE Execution] Put entry : $${putEntry.toFixed(2)}, SL trigger: $${putStopLoss}`);

  const callLeg: OneDteLeg = {
    legType: 'CALL',
    symbol: call.symbol,
    strikePrice: call.strikePrice,
    entryPrice: callEntry,
    stopLossPrice: callStopLoss,
    quantity: config.orderQuantity,
    entryBid: currentCallBid,
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
    entryBid: currentPutBid,
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

