import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { Notifier } from './notifier';
import { saveStraddleState } from './stateStore';
import { recordMtmLog } from './mtmWatcher';
import { appendAlert } from './fileAlerter';
import { isPositionOpenOnExchange, parseContractExpiryDate, safeCloseLeg } from './reconciliation';
import { CycleRecordWriter } from './records/cycleRecordWriter';
import { parseContractExpiryDate as parseExpiryString } from './reports/reportDataCollector';
import {
  ActiveLeg,
  EntryPriceSource,
  LegCloseReason,
  OrderPlacementOutcome,
  StraddlePositionState,
  TradeScenario,
} from './types';

export class MissingFillPriceError extends Error {
  constructor(symbol: string) {
    super(`Unable to resolve a valid fill or contract mark price for symbol: ${symbol}. Refusing to invent entry price.`);
    this.name = 'MissingFillPriceError';
  }
}

/**
 * Resolves the entry price for a filled leg.
 * Never invents or fabricates a fallback price.
 * 1. Checks order outcome rawResponse (avg_price, then price).
 * 2. If unavailable, falls back to live contract price ONLY if > 0.
 * 3. Returns null if no valid positive price is found.
 */
export async function resolveEntryPrice(
  outcome: OrderPlacementOutcome,
  client: CoinDCXClient,
  symbol: string
): Promise<{ readonly price: number; readonly source: EntryPriceSource } | null> {
  const raw = outcome.rawResponse;

  if (typeof raw.avg_price === 'number' && Number.isFinite(raw.avg_price) && raw.avg_price > 0) {
    return { price: raw.avg_price, source: 'fill' };
  }
  if (typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price > 0) {
    return { price: raw.price, source: 'fill' };
  }
  if (typeof raw.price === 'string') {
    const parsed = Number(raw.price);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { price: parsed, source: 'fill' };
    }
  }

  const orderData = raw.data as Record<string, unknown> | undefined;
  if (orderData) {
    const dAvg = Number(orderData.avg_price ?? orderData.avgPrice ?? orderData.price);
    if (Number.isFinite(dAvg) && dAvg > 0) {
      return { price: dAvg, source: 'fill' };
    }
  }

  // Fallback to posted limit price:
  // Falling back to outcome.limitPrice is legitimate because this was the real,
  // known marketable limit price quoted from the exchange orderbook bidPrice and submitted in
  // the order request. This is fundamentally different from inventing an arbitrary
  // placeholder (such as 500) out of thin air.
  if (outcome.limitPrice !== undefined && Number.isFinite(outcome.limitPrice) && outcome.limitPrice > 0) {
    return { price: outcome.limitPrice, source: 'fill' };
  }

  // Fallback: poll live contract price via public/authenticated ticker
  try {
    const contractPrice = await client.getContractPrice(symbol);
    if (Number.isFinite(contractPrice) && contractPrice > 0) {
      return { price: contractPrice, source: 'mark' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Risk Manager] Failed to fetch contract mark price fallback for ${symbol}: ${msg}`);
  }

  return null;
}

/**
 * Initializes the live tracking state for a Short Straddle.
 * Throws MissingFillPriceError if entry price cannot be resolved.
 */
export async function initializeStraddleState(
  callOutcome: OrderPlacementOutcome,
  putOutcome: OrderPlacementOutcome,
  client: CoinDCXClient,
  config: AppConfig,
  callFillPrice?: number,
  putFillPrice?: number,
  dateStr = new Date().toISOString().slice(0, 10)
): Promise<StraddlePositionState> {
  let callEntry: number;
  let callSource: EntryPriceSource = 'fill';
  if (callFillPrice !== undefined && Number.isFinite(callFillPrice) && callFillPrice > 0) {
    callEntry = callFillPrice;
  } else {
    const resolved = await resolveEntryPrice(callOutcome, client, callOutcome.symbol);
    if (!resolved) {
      throw new MissingFillPriceError(callOutcome.symbol);
    }
    callEntry = resolved.price;
    callSource = resolved.source;
  }

  let putEntry: number;
  let putSource: EntryPriceSource = 'fill';
  if (putFillPrice !== undefined && Number.isFinite(putFillPrice) && putFillPrice > 0) {
    putEntry = putFillPrice;
  } else {
    const resolved = await resolveEntryPrice(putOutcome, client, putOutcome.symbol);
    if (!resolved) {
      throw new MissingFillPriceError(putOutcome.symbol);
    }
    putEntry = resolved.price;
    putSource = resolved.source;
  }

  const callSL = callEntry * config.riskConfig.stopLossMultiplier;
  const putSL = putEntry * config.riskConfig.stopLossMultiplier;

  console.log(`[Risk Manager] Call entry resolved: $${callEntry.toFixed(2)} (source: ${callSource})`);
  console.log(`[Risk Manager] Put entry resolved: $${putEntry.toFixed(2)} (source: ${putSource})`);

  const callLeg: ActiveLeg = {
    legType: 'CALL',
    symbol: callOutcome.symbol,
    entryPrice: callEntry,
    entryPriceSource: callSource,
    stopLossPrice: callSL,
    quantity: config.orderQuantity,
    orderId: callOutcome.orderId,
    confirmedOpen: true,
    status: 'open',
    currentPrice: callEntry,
  };

  const putLeg: ActiveLeg = {
    legType: 'PUT',
    symbol: putOutcome.symbol,
    entryPrice: putEntry,
    entryPriceSource: putSource,
    stopLossPrice: putSL,
    quantity: config.orderQuantity,
    orderId: putOutcome.orderId,
    confirmedOpen: true,
    status: 'open',
    currentPrice: putEntry,
  };

  const totalCreditReceived = callEntry + putEntry;
  const targetProfitPoints = totalCreditReceived * config.riskConfig.profitTargetRatio;

  return {
    date: dateStr,
    entryExecuted: true,
    callLeg,
    putLeg,
    totalCreditReceived,
    targetProfitPoints,
    combinedPnLPoints: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Calculates the current points PnL for a leg.
 * For sold options: Profit = Entry Price - Current Price (or Exit Price)
 */
export function calculateLegPnL(leg: ActiveLeg): number {
  if (leg.status === 'closed') {
    return leg.entryPrice - (leg.exitPrice ?? leg.stopLossPrice);
  }
  return leg.entryPrice - leg.currentPrice;
}

/**
 * Closes an individual active leg.
 * Guarded against closing unconfirmed or already closed legs.
 * NEVER marks closed in state if the exchange rejects the exit.
 */
export async function closeLeg(
  client: CoinDCXClient,
  leg: ActiveLeg,
  currentPrice: number,
  reason: LegCloseReason,
  config: AppConfig,
  notifier?: Notifier
): Promise<boolean> {
  const result = await safeCloseLeg(client, leg, currentPrice, reason, config, notifier);
  return result.success;
}

/**
 * Monitors the short straddle position until one of the scenarios resolves:
 * 1. 55% Profit Target reached (both legs closed in profit)
 * 2. One leg hits 100% SL, other leg continues and covers target
 * 3. Both legs hit 100% SL
 * 4. Max monitoring duration reached (end-of-life cutoff)
 */
export async function monitorStraddleRisk(
  client: CoinDCXClient,
  state: StraddlePositionState,
  config: AppConfig,
  notifier?: Notifier
): Promise<TradeScenario> {
  console.log('\n==================================================');
  console.log('       STRADDLE RISK MONITORING ACTIVE            ');
  console.log('==================================================');
  console.log(`[Config] Call Entry : $${state.callLeg.entryPrice.toFixed(2)} (${state.callLeg.entryPriceSource}) | SL: $${state.callLeg.stopLossPrice.toFixed(2)} (+100%)`);
  console.log(`[Config] Put Entry  : $${state.putLeg.entryPrice.toFixed(2)} (${state.putLeg.entryPriceSource}) | SL: $${state.putLeg.stopLossPrice.toFixed(2)} (+100%)`);
  console.log(`[Config] Total Credit: $${state.totalCreditReceived.toFixed(2)} points`);
  console.log(`[Config] Profit Target: +$${state.targetProfitPoints.toFixed(2)} points (55% of credit)`);
  console.log('==================================================\n');

  const startTime = Date.now();
  const maxMonitorMs = (config.riskConfig.maxMonitorMinutes ?? 720) * 60 * 1000;

  const cycleExpiryStr = parseExpiryString(state.callLeg.symbol) || parseExpiryString(state.putLeg.symbol) || state.date;
  const recordWriter = new CycleRecordWriter(cycleExpiryStr);
  let lastCheckpointTime = Date.now();
  const checkpointInterval = config.checkpointIntervalMs ?? 300_000;

  return new Promise<TradeScenario>((resolve) => {
    let timer: NodeJS.Timeout | null = null;

    const cleanupAndResolve = async (scenario: TradeScenario): Promise<void> => {
      try {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        state.resolvedScenario = scenario;
        state.updatedAt = new Date().toISOString();
        await saveStraddleState(state, state.date);

        // Record CYCLE_CLOSED
        recordWriter.appendEvent('CYCLE_CLOSED', {
          resolvedScenario: scenario,
          combinedPnLPoints: state.combinedPnLPoints,
          callStatus: state.callLeg.status,
          callExitPrice: state.callLeg.exitPrice,
          putStatus: state.putLeg.status,
          putExitPrice: state.putLeg.exitPrice,
        });

        // Write terminal summary snapshot
        recordWriter.writeSummarySnapshot({
          schemaVersion: 1,
          cycle: cycleExpiryStr,
          entryDate: state.date,
          updatedAt: new Date().toISOString(),
          status: 'CLOSED',
          totalCreditReceived: state.totalCreditReceived,
          targetProfitPoints: state.targetProfitPoints,
          callLeg: {
            symbol: state.callLeg.symbol,
            entryPrice: state.callLeg.entryPrice,
            venueAvgPrice: state.callLeg.venueAvgPrice,
            status: state.callLeg.status,
            exitPrice: state.callLeg.exitPrice,
            closeReason: state.callLeg.closeReason,
            orderId: state.callLeg.orderId,
            closeOrderId: state.callLeg.exitOrderId,
            pnlPoints: state.callLeg.exitPrice !== null && state.callLeg.exitPrice !== undefined
              ? state.callLeg.entryPrice - state.callLeg.exitPrice
              : null,
          },
          putLeg: {
            symbol: state.putLeg.symbol,
            entryPrice: state.putLeg.entryPrice,
            venueAvgPrice: state.putLeg.venueAvgPrice,
            status: state.putLeg.status,
            exitPrice: state.putLeg.exitPrice,
            closeReason: state.putLeg.closeReason,
            orderId: state.putLeg.orderId,
            closeOrderId: state.putLeg.exitOrderId,
            pnlPoints: state.putLeg.exitPrice !== null && state.putLeg.exitPrice !== undefined
              ? state.putLeg.entryPrice - state.putLeg.exitPrice
              : null,
          },
          combinedPnLPoints: state.combinedPnLPoints,
          resolvedScenario: scenario,
        });

        if (notifier) {
          const summary =
            `Scenario: ${scenario} | Final PnL: ${state.combinedPnLPoints.toFixed(2)} pts | ` +
            `Call: $${state.callLeg.exitPrice?.toFixed(2) ?? state.callLeg.currentPrice.toFixed(2)} (${state.callLeg.status}) | ` +
            `Put: $${state.putLeg.exitPrice?.toFixed(2) ?? state.putLeg.currentPrice.toFixed(2)} (${state.putLeg.status})`;
          void notifier.notifyScenarioResolved({
            scenario,
            totalCredit: state.totalCreditReceived,
            combinedPnL: state.combinedPnLPoints,
            summary,
          });
        }
      } catch (err) {
        console.error('[Risk Manager] Error during monitor resolution cleanup:', err);
      } finally {
        resolve(scenario);
      }
    };

    timer = setInterval(async () => {
      try {
        // Fetch current prices for open legs
        let anyFeedMissing = false;

        for (const leg of [state.callLeg, state.putLeg]) {
          if (leg.status !== 'open') {
            continue;
          }

          // ── Expiry-aware handling ─────────────────────────────────────────
          // A contract past its expiry cannot be priced any more: the venue
          // delists it, the positions feed drops it, and the public options
          // ticker rejects a past expiry outright ("expiry time must be greater
          // than current time"). Polling it anyway produced a
          // "price feed unavailable" alert on EVERY poll — twice a second for
          // hours on 2026-10-05. So stop asking and reconcile instead.
          const contractExpiry = parseContractExpiryDate(leg.symbol, config.dailyExpiryHourUTC);
          const expiryPassed = contractExpiry !== null && Date.now() >= contractExpiry.getTime();

          if (expiryPassed) {
            // Tri-state: true = still listed, false = confirmed absent, null = unverifiable.
            const stillListed = await isPositionOpenOnExchange(client, leg.symbol);

            if (stillListed === false) {
              // Confirmed gone from the exchange after expiry. The settlement value
              // is NOT exposed by the API, so record the expiry without inventing
              // one — never silently zero a surviving mark.
              leg.status = 'closed';
              leg.closeReason = 'EXPIRED';
              state.updatedAt = new Date().toISOString();
              await saveStraddleState(state, state.date);

              const msg =
                `${leg.legType} ${leg.symbol} expired at ${contractExpiry.toISOString()} and is no longer ` +
                `listed on the exchange (last known mark $${leg.currentPrice.toFixed(2)}). Settlement value ` +
                `is not exposed by the API — final P&L may differ.`;
              console.warn(`[Risk Manager] ⏳ ${msg}`);
              appendAlert('leg_expired', msg, { symbol: leg.symbol, leg: leg.legType }, {
                dedupKey: `leg_expired:${leg.symbol}`,
              });
              if (notifier) {
                void notifier.notifyLegClosed({
                  legType: leg.legType,
                  symbol: leg.symbol,
                  reason: 'EXPIRED',
                  exitPrice: leg.currentPrice,
                  runningPnL: leg.entryPrice - leg.currentPrice,
                });
              }
              continue;
            }

            if (stillListed === null) {
              // Could not verify against the exchange. Keep the leg OPEN and
              // monitored (never claim a close we cannot prove), but do not poll a
              // price the venue is already refusing to give.
              anyFeedMissing = true;
              const msg =
                `Expiry reconciliation failed for ${leg.legType} ${leg.symbol}: could not read the exchange ` +
                `positions feed. Leg kept OPEN and monitored. Last known mark $${leg.currentPrice.toFixed(2)}.`;
              console.error(`[Risk Manager] 🚨 ${msg}`);
              appendAlert('feed_unavailable', msg, { symbol: leg.symbol, leg: leg.legType }, {
                dedupKey: `feed_unavailable:${leg.symbol}`,
              });
              if (notifier) {
                void notifier.notifyError(`monitorStraddleRisk:${leg.legType}_price_feed`, new Error(msg));
              }
              continue;
            }

            // Still listed after expiry — keep tracking it normally (fall through).
          }

          const livePrice = await client.getContractPrice(leg.symbol);
          if (livePrice > 0) {
            leg.currentPrice = livePrice;
          } else {
            anyFeedMissing = true;
            const msg = `Price feed unavailable for ${leg.legType} ${leg.symbol}. Live mark cannot be verified. Retaining last known: $${leg.currentPrice.toFixed(2)}`;
            console.error(`[Risk Manager] 🚨 ${msg}`);
            appendAlert('feed_unavailable', msg, { symbol: leg.symbol, leg: leg.legType }, {
              dedupKey: `feed_unavailable:${leg.symbol}`,
            });
            if (notifier) {
              void notifier.notifyError(`monitorStraddleRisk:${leg.legType}_price_feed`, new Error(msg));
            }
          }
        }

        if (anyFeedMissing) {
          console.warn('[Risk Manager] ⚠️ Position valuation is degraded due to missing mark price(s).');
        }

        // Both legs are gone => the cycle is over. Resolve and stop the monitor
        // rather than polling a dead contract until the next process restart.
        if (state.callLeg.status === 'closed' && state.putLeg.status === 'closed') {
          state.combinedPnLPoints = calculateLegPnL(state.callLeg) + calculateLegPnL(state.putLeg);
          void recordMtmLog(state.combinedPnLPoints, new Date(), state.date);
          console.warn(
            `[Risk Manager] ✅ Both legs closed (CALL: ${state.callLeg.closeReason ?? 'n/a'} | ` +
              `PUT: ${state.putLeg.closeReason ?? 'n/a'}) — resolving cycle after expiry reconciliation.`
          );
          await cleanupAndResolve('MAX_TIME_REACHED');
          return;
        }

        // End-of-life cutoff check
        if (Date.now() - startTime >= maxMonitorMs) {
          // Check if contract has actually expired or if only the monitor window elapsed
          const sampleSymbol = (state.callLeg.status === 'open' ? state.callLeg.symbol : state.putLeg.symbol) || '';
          const contractExpiry = parseContractExpiryDate(sampleSymbol, config.dailyExpiryHourUTC);
          const isActualContractExpired = contractExpiry ? Date.now() >= contractExpiry.getTime() : false;
          const closeReason: LegCloseReason = isActualContractExpired ? 'EXPIRED' : 'MONITOR_WINDOW_ELAPSED';

          console.warn(
            `[Risk Manager] ⏰ Max monitor duration reached (${config.riskConfig.maxMonitorMinutes ?? 1380} mins). ` +
            `Contract expiry: ${contractExpiry ? contractExpiry.toISOString() : 'unknown'} -> Reason: ${closeReason}`
          );

          if (state.callLeg.status === 'open') {
            await closeLeg(client, state.callLeg, state.callLeg.currentPrice, closeReason, config, notifier);
          }
          if (state.putLeg.status === 'open') {
            await closeLeg(client, state.putLeg, state.putLeg.currentPrice, closeReason, config, notifier);
          }

          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);

          // Only resolve and stop monitoring if all legs are confirmed closed!
          if (state.callLeg.status === 'closed' && state.putLeg.status === 'closed') {
            await cleanupAndResolve('MAX_TIME_REACHED');
            return;
          } else {
            console.warn('[Risk Manager] ⚠️ Legs still open after window cutoff close attempt — continuing monitor!');
          }
        }

        // Check Individual Leg Stop Losses (100% SL)
        if (
          state.callLeg.status === 'open' &&
          state.callLeg.currentPrice >= state.callLeg.stopLossPrice
        ) {
          console.warn(`[Risk Manager] ⚠️ CALL leg hit 100% Stop Loss! Price: $${state.callLeg.currentPrice.toFixed(2)} >= SL: $${state.callLeg.stopLossPrice.toFixed(2)}`);
          recordWriter.appendEvent('LEG_SL_HIT', {
            legType: 'CALL',
            symbol: state.callLeg.symbol,
            price: state.callLeg.currentPrice,
            stopLossPrice: state.callLeg.stopLossPrice,
          });
          await closeLeg(
            client,
            state.callLeg,
            state.callLeg.currentPrice,
            'SL_HIT',
            config,
            notifier
          );
          recordWriter.appendEvent('LEG_CLOSED', {
            legType: 'CALL',
            symbol: state.callLeg.symbol,
            reason: 'SL_HIT',
            exitPrice: state.callLeg.exitPrice ?? state.callLeg.currentPrice,
          });
          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);
        }

        if (
          state.putLeg.status === 'open' &&
          state.putLeg.currentPrice >= state.putLeg.stopLossPrice
        ) {
          console.warn(`[Risk Manager] ⚠️ PUT leg hit 100% Stop Loss! Price: $${state.putLeg.currentPrice.toFixed(2)} >= SL: $${state.putLeg.stopLossPrice.toFixed(2)}`);
          recordWriter.appendEvent('LEG_SL_HIT', {
            legType: 'PUT',
            symbol: state.putLeg.symbol,
            price: state.putLeg.currentPrice,
            stopLossPrice: state.putLeg.stopLossPrice,
          });
          await closeLeg(
            client,
            state.putLeg,
            state.putLeg.currentPrice,
            'SL_HIT',
            config,
            notifier
          );
          recordWriter.appendEvent('LEG_CLOSED', {
            legType: 'PUT',
            symbol: state.putLeg.symbol,
            reason: 'SL_HIT',
            exitPrice: state.putLeg.exitPrice ?? state.putLeg.currentPrice,
          });
          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);
        }

        // Calculate current Combined PnL in points
        const callPnL = calculateLegPnL(state.callLeg);
        const putPnL = calculateLegPnL(state.putLeg);
        state.combinedPnLPoints = callPnL + putPnL;

        // Record MTM to daily log file and dedicated cycle MTM tape
        void recordMtmLog(state.combinedPnLPoints, new Date(), state.date);
        recordWriter.appendMtmTape({
          ts: new Date().toISOString(),
          callMark: state.callLeg.currentPrice,
          putMark: state.putLeg.currentPrice,
          combinedPts: state.combinedPnLPoints,
        });

        // 5-minute periodic checkpoint event
        if (Date.now() - lastCheckpointTime >= checkpointInterval) {
          lastCheckpointTime = Date.now();
          recordWriter.appendEvent('MTM_CHECKPOINT', {
            callMark: state.callLeg.currentPrice,
            putMark: state.putLeg.currentPrice,
            combinedPnLPoints: state.combinedPnLPoints,
            callStatus: state.callLeg.status,
            putStatus: state.putLeg.status,
          });
        }

        console.log(
          `[Monitor] CALL: $${state.callLeg.currentPrice.toFixed(2)} (${state.callLeg.status}) | ` +
          `PUT: $${state.putLeg.currentPrice.toFixed(2)} (${state.putLeg.status}) | ` +
          `Combined PnL: ${state.combinedPnLPoints >= 0 ? '+' : ''}${state.combinedPnLPoints.toFixed(2)} / +${state.targetProfitPoints.toFixed(2)} pts`
        );

        // Scenario 1 & 2: Check if Profit Target of 55% is achieved
        if (state.combinedPnLPoints >= state.targetProfitPoints) {
          const wasOneLegStopped =
            state.callLeg.status === 'closed' || state.putLeg.status === 'closed';

          const resolvedScenario: TradeScenario = wasOneLegStopped
            ? 'ONE_LEG_SL_OTHER_COVERED'
            : 'PROFIT_TARGET_REACHED';

          console.log('\n🎯 ==============================================');
          recordWriter.appendEvent('TARGET_HIT', {
            targetProfitPoints: state.targetProfitPoints,
            combinedPnLPoints: state.combinedPnLPoints,
            resolvedScenario,
          });

          // Close all open remaining legs
          if (state.callLeg.status === 'open') {
            await closeLeg(client, state.callLeg, state.callLeg.currentPrice, 'PROFIT_TARGET_HIT', config, notifier);
          }
          if (state.putLeg.status === 'open') {
            await closeLeg(client, state.putLeg, state.putLeg.currentPrice, 'PROFIT_TARGET_HIT', config, notifier);
          }

          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);

          if (state.callLeg.status === 'closed' && state.putLeg.status === 'closed') {
            await cleanupAndResolve(resolvedScenario);
            return;
          } else {
            console.warn('[Risk Manager] ⚠️ Leg(s) failed to close during profit target squareoff — continuing monitor!');
          }
        }

        // Scenario 3: Check if both legs hit Stop Loss
        if (
          state.callLeg.status === 'closed' &&
          state.putLeg.status === 'closed' &&
          state.callLeg.closeReason === 'SL_HIT' &&
          state.putLeg.closeReason === 'SL_HIT'
        ) {
          console.log('\n🛑 ==============================================');
          console.log('🛑 BOTH LEGS STOP LOSS TRIGGERED (-100% on both)');
          console.log(`🛑 Total Points Loss: ${state.combinedPnLPoints.toFixed(2)} points`);
          console.log('🛑 Trade concluded under Scenario 3.');
          console.log('🛑 ==============================================\n');

          await cleanupAndResolve('BOTH_LEGS_SL');
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Risk Manager] Error during position polling: ${message}`);
        if (notifier) {
          void notifier.notifyError('monitorStraddleRisk', error);
        }
      }
    }, config.riskConfig.pollIntervalMs);
  });
}
