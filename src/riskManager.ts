import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import {
  ActiveLeg,
  LegCloseReason,
  OrderPlacementOutcome,
  StraddlePositionState,
  TradeScenario,
} from './types';

/**
 * Parses execution fill price from the order outcome or falls back to latest contract price.
 */
function extractFillPrice(
  outcome: OrderPlacementOutcome,
  fallbackPrice = 100
): number {
  const raw = outcome.rawResponse;

  if (typeof raw.avg_price === 'number' && raw.avg_price > 0) {
    return raw.avg_price;
  }
  if (typeof raw.price === 'number' && raw.price > 0) {
    return raw.price;
  }
  if (typeof raw.price === 'string') {
    const parsed = Number(raw.price);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // If order placement was in dry-run or mock mode, use a realistic fallback baseline (e.g. 100 points)
  return fallbackPrice;
}

/**
 * Initializes the live tracking state for a Short Straddle.
 */
export function initializeStraddleState(
  callOutcome: OrderPlacementOutcome,
  putOutcome: OrderPlacementOutcome,
  config: AppConfig,
  callFillPrice?: number,
  putFillPrice?: number
): StraddlePositionState {
  const callEntry = callFillPrice ?? extractFillPrice(callOutcome, 100);
  const putEntry = putFillPrice ?? extractFillPrice(putOutcome, 100);

  const callSL = callEntry * config.riskConfig.stopLossMultiplier;
  const putSL = putEntry * config.riskConfig.stopLossMultiplier;

  const callLeg: ActiveLeg = {
    legType: 'CALL',
    symbol: callOutcome.symbol,
    entryPrice: callEntry,
    stopLossPrice: callSL,
    quantity: config.orderQuantity,
    status: 'open',
    currentPrice: callEntry,
  };

  const putLeg: ActiveLeg = {
    legType: 'PUT',
    symbol: putOutcome.symbol,
    entryPrice: putEntry,
    stopLossPrice: putSL,
    quantity: config.orderQuantity,
    status: 'open',
    currentPrice: putEntry,
  };

  const totalCreditReceived = callEntry + putEntry;
  const targetProfitPoints = totalCreditReceived * config.riskConfig.profitTargetRatio;

  return {
    callLeg,
    putLeg,
    totalCreditReceived,
    targetProfitPoints,
    combinedPnLPoints: 0,
  };
}

/**
 * Calculates the current points PnL for a leg.
 * For sold options: Profit = Entry Price - Current Price (or Exit Price)
 */
function calculateLegPnL(leg: ActiveLeg): number {
  if (leg.status === 'closed') {
    return leg.entryPrice - (leg.exitPrice ?? leg.stopLossPrice);
  }
  return leg.entryPrice - leg.currentPrice;
}

/**
 * Closes an individual active leg.
 */
async function closeLeg(
  client: CoinDCXClient,
  leg: ActiveLeg,
  currentPrice: number,
  reason: LegCloseReason,
  config: AppConfig
): Promise<void> {
  leg.status = 'closed';
  leg.exitPrice = currentPrice;
  leg.closeReason = reason;

  console.log(
    `[Risk Manager] 🚨 Closing ${leg.legType} (${leg.symbol}) at $${currentPrice.toFixed(
      2
    )} | Reason: ${reason}`
  );

  const result = await client.closePosition(
    leg.symbol,
    leg.quantity,
    config.leverage
  );

  if (result.success) {
    console.log(
      `[Risk Manager] ✅ ${leg.legType} buy-to-close order placed. Order ID: ${result.orderId || 'N/A'}`
    );
  } else {
    console.error(
      `[Risk Manager] ⚠️ ${leg.legType} close order response: ${result.message || 'Check terminal'}`
    );
  }
}

/**
 * Monitors the short straddle position until one of the 3 scenarios resolves:
 * 1. 55% Profit Target reached (both legs closed in profit)
 * 2. One leg hits 100% SL, other leg continues and covers target
 * 3. Both legs hit 100% SL
 */
export async function monitorStraddleRisk(
  client: CoinDCXClient,
  state: StraddlePositionState,
  config: AppConfig
): Promise<TradeScenario> {
  console.log('\n==================================================');
  console.log('       STRADDLE RISK MONITORING ACTIVE            ');
  console.log('==================================================');
  console.log(`[Config] Call Entry : $${state.callLeg.entryPrice.toFixed(2)} | SL: $${state.callLeg.stopLossPrice.toFixed(2)} (+100%)`);
  console.log(`[Config] Put Entry  : $${state.putLeg.entryPrice.toFixed(2)} | SL: $${state.putLeg.stopLossPrice.toFixed(2)} (+100%)`);
  console.log(`[Config] Total Credit: $${state.totalCreditReceived.toFixed(2)} points`);
  console.log(`[Config] Profit Target: +$${state.targetProfitPoints.toFixed(2)} points (55% of credit)`);
  console.log('==================================================\n');

  return new Promise<TradeScenario>((resolve) => {
    const timer = setInterval(async () => {
      try {
        // Fetch current prices for open legs
        if (state.callLeg.status === 'open') {
          const liveCallPrice = await client.getContractPrice(state.callLeg.symbol);
          if (liveCallPrice > 0) state.callLeg.currentPrice = liveCallPrice;
        }

        if (state.putLeg.status === 'open') {
          const livePutPrice = await client.getContractPrice(state.putLeg.symbol);
          if (livePutPrice > 0) state.putLeg.currentPrice = livePutPrice;
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
            config
          );
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
            config
          );
        }

        // Calculate current Combined PnL in points
        const callPnL = calculateLegPnL(state.callLeg);
        const putPnL = calculateLegPnL(state.putLeg);
        state.combinedPnLPoints = callPnL + putPnL;

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

          state.resolvedScenario = resolvedScenario;
          clearInterval(timer);

          console.log('\n🎯 ==============================================');
          console.log(`🎯 PROFIT TARGET ACHIEVED: +${state.combinedPnLPoints.toFixed(2)} points!`);
          console.log(`🎯 Scenario: ${resolvedScenario}`);
          console.log('🎯 Closing remaining open legs...');
          console.log('🎯 ==============================================\n');

          // Close all open remaining legs
          if (state.callLeg.status === 'open') {
            await closeLeg(client, state.callLeg, state.callLeg.currentPrice, 'PROFIT_TARGET_HIT', config);
          }
          if (state.putLeg.status === 'open') {
            await closeLeg(client, state.putLeg, state.putLeg.currentPrice, 'PROFIT_TARGET_HIT', config);
          }

          resolve(resolvedScenario);
          return;
        }

        // Scenario 3: Check if both legs hit Stop Loss
        if (
          state.callLeg.status === 'closed' &&
          state.putLeg.status === 'closed' &&
          state.callLeg.closeReason === 'SL_HIT' &&
          state.putLeg.closeReason === 'SL_HIT'
        ) {
          const resolvedScenario: TradeScenario = 'BOTH_LEGS_SL';
          state.resolvedScenario = resolvedScenario;
          clearInterval(timer);

          console.log('\n🛑 ==============================================');
          console.log('🛑 BOTH LEGS STOP LOSS TRIGGERED (-100% on both)');
          console.log(`🛑 Total Points Loss: ${state.combinedPnLPoints.toFixed(2)} points`);
          console.log('🛑 Trade concluded under Scenario 3.');
          console.log('🛑 ==============================================\n');

          resolve(resolvedScenario);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Risk Manager] Error during position polling: ${message}`);
      }
    }, config.riskConfig.pollIntervalMs);
  });
}
