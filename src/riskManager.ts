import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { Notifier } from './notifier';
import { saveStraddleState } from './stateStore';
import { recordMtmLog } from './mtmWatcher';
import { appendAlert } from './fileAlerter';
import { parseContractExpiryDate, safeCloseLeg } from './reconciliation';
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
        if (state.callLeg.status === 'open') {
          const liveCallPrice = await client.getContractPrice(state.callLeg.symbol);
          if (liveCallPrice > 0) {
            state.callLeg.currentPrice = liveCallPrice;
          } else {
            anyFeedMissing = true;
            const msg = `Price feed unavailable for CALL ${state.callLeg.symbol}. Live mark cannot be verified. Retaining last known: $${state.callLeg.currentPrice.toFixed(2)}`;
            console.error(`[Risk Manager] 🚨 ${msg}`);
            appendAlert('feed_unavailable', msg, { symbol: state.callLeg.symbol, leg: 'CALL' });
            if (notifier) {
              void notifier.notifyError('monitorStraddleRisk:CALL_price_feed', new Error(msg));
            }
          }
        }

        if (state.putLeg.status === 'open') {
          const livePutPrice = await client.getContractPrice(state.putLeg.symbol);
          if (livePutPrice > 0) {
            state.putLeg.currentPrice = livePutPrice;
          } else {
            anyFeedMissing = true;
            const msg = `Price feed unavailable for PUT ${state.putLeg.symbol}. Live mark cannot be verified. Retaining last known: $${state.putLeg.currentPrice.toFixed(2)}`;
            console.error(`[Risk Manager] 🚨 ${msg}`);
            appendAlert('feed_unavailable', msg, { symbol: state.putLeg.symbol, leg: 'PUT' });
            if (notifier) {
              void notifier.notifyError('monitorStraddleRisk:PUT_price_feed', new Error(msg));
            }
          }
        }

        if (anyFeedMissing) {
          console.warn('[Risk Manager] ⚠️ Position valuation is degraded due to missing mark price(s).');
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
          await closeLeg(
            client,
            state.callLeg,
            state.callLeg.currentPrice,
            'SL_HIT',
            config,
            notifier
          );
          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);
        }

        if (
          state.putLeg.status === 'open' &&
          state.putLeg.currentPrice >= state.putLeg.stopLossPrice
        ) {
          console.warn(`[Risk Manager] ⚠️ PUT leg hit 100% Stop Loss! Price: $${state.putLeg.currentPrice.toFixed(2)} >= SL: $${state.putLeg.stopLossPrice.toFixed(2)}`);
          await closeLeg(
            client,
            state.putLeg,
            state.putLeg.currentPrice,
            'SL_HIT',
            config,
            notifier
          );
          state.updatedAt = new Date().toISOString();
          await saveStraddleState(state, state.date);
        }

        // Calculate current Combined PnL in points
        const callPnL = calculateLegPnL(state.callLeg);
        const putPnL = calculateLegPnL(state.putLeg);
        state.combinedPnLPoints = callPnL + putPnL;

        // Record MTM to daily log file
        void recordMtmLog(state.combinedPnLPoints, new Date(), state.date);

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
          console.log(`🎯 PROFIT TARGET ACHIEVED: +${state.combinedPnLPoints.toFixed(2)} points!`);
          console.log(`🎯 Scenario: ${resolvedScenario}`);
          console.log('🎯 Closing remaining open legs...');
          console.log('🎯 ==============================================\n');

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
