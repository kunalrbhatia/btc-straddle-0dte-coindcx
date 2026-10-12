import { CoinDCXClient } from '../client';
import { TelegramNotifier } from '../notifier';
import { OneDteConfig } from './config';
import { OneDtePositionState, OneDteLeg } from './types';
import { saveOneDteState } from './stateStore';

/**
 * Combined gain of the cycle so far, in points: (entry - current) for each open leg and
 * (entry - exit) for each closed leg.
 *
 * Returns null when any leg's price is unknown, so the profit target is never acted on with
 * partial or stale data — a missing mark must not look like a winning position.
 */
export function combinedGainPoints(state: OneDtePositionState): number | null {
  let gain = 0;
  for (const leg of [state.callLeg, state.putLeg]) {
    if (leg.status === 'closed') {
      if (leg.exitPrice === undefined || leg.exitPrice === null) return null;
      gain += leg.entryPrice - leg.exitPrice;
    } else {
      if (!(leg.currentPrice > 0)) return null;
      gain += leg.entryPrice - leg.currentPrice;
    }
  }
  return gain;
}

export async function monitorOneDteRisk(
  client: CoinDCXClient,
  state: OneDtePositionState,
  config: OneDteConfig,
  notifier?: TelegramNotifier
): Promise<void> {
  const targetPoints = state.totalCreditReceived * config.profitTargetRatio;

  console.log('==================================================');
  console.log('       1 DTE POSITION MONITORING ACTIVE           ');
  console.log(` Target Exit Time: ${new Date(state.targetExitUtcMs).toISOString()}`);
  console.log(
    ` Profit Target   : ${(config.profitTargetRatio * 100).toFixed(0)}% of credit sold ` +
      `($${state.totalCreditReceived.toFixed(2)} pts credit -> exit at $${targetPoints.toFixed(2)} pts)`
  );
  console.log('==================================================');

  const checkIntervalMs = config.pollIntervalMs;

  // Symbols this process has actually observed open at the venue. A closure is only ever adopted
  // for one of these, so a glitched or empty positions read can never write off a live position.
  const seenOpen = new Set<string>();

  while (state.status === 'active') {
    const nowMs = Date.now();

    // 1. Check if Scheduled Exit Time (5:45 PM IST next day) has arrived
    if (nowMs >= state.targetExitUtcMs) {
      console.log(
        `[1DTE Monitor] ⏰ Reached scheduled exit time (${config.exitHourIST}:${String(config.exitMinuteIST).padStart(2, '0')} IST). Closing remaining open legs...`
      );
      await closeRemainingLegs(client, state, 'MONITOR_WINDOW_ELAPSED', notifier);
      const finalGain = combinedGainPoints(state);
      if (finalGain !== null) state.combinedPnLPoints = finalGain;
      state.status = 'closed';
      await saveOneDteState(state, state.date);
      break;
    }

    // 2. Fetch live positions from CoinDCX
    try {
      const positions = await client.getOptionsPositions();
      // A position row on this venue carries NO qty/quantity field — only positionValue, a string.
      // Filtering on qty matched nothing and made every open leg look closed ("closed by venue SL"):
      // that one line is what blinded the bot in both 1 DTE cycles (22:45:01 and 06:56:23) and in the
      // 0 DTE era before it. A row's *presence* is the signal; only an explicitly flat row is absent.
      const openVenueSymbols = new Set(
        positions
          .filter((p) => {
            const raw = p as Record<string, unknown>;
            const pv = Number(raw.positionValue);
            if (Number.isFinite(pv)) return pv !== 0;
            const q = Number(raw.qty ?? raw.quantity);
            if (Number.isFinite(q)) return q !== 0;
            return true; // no size fields at all (the normal case here): the row itself is the signal
          })
          .map((p) => p.symbol)
      );
      for (const sym of openVenueSymbols) seenOpen.add(sym);

      // Check each leg
      for (const leg of [state.callLeg, state.putLeg]) {
        if (leg.status !== 'open') continue;

        // Has position vanished from venue? (e.g. SL hit on exchange)
        if (!openVenueSymbols.has(leg.symbol)) {
          if (!seenOpen.has(leg.symbol)) {
            console.warn(
              `[1DTE Monitor] ⚠️ Leg ${leg.legType} (${leg.symbol}) not visible at the venue yet — NOT adopting it as closed.`
            );
            continue;
          }
          console.log(`[1DTE Monitor] 🎯 Leg ${leg.legType} (${leg.symbol}) no longer open on exchange (closed by venue SL).`);
          leg.status = 'closed';
          leg.closeReason = 'SL_HIT';
          leg.exitPrice = leg.stopLossPrice;
          await saveOneDteState(state, state.date);

          if (notifier) {
            void notifier.notifyLegClosed({
              legType: leg.legType,
              symbol: leg.symbol,
              reason: 'SL_HIT',
              exitPrice: leg.exitPrice,
              runningPnL: leg.entryPrice - leg.exitPrice,
            });
          }
          continue;
        }

        // Leg is still open on venue -> check live price against fallback threshold
        const currentPrice = await client.getContractPrice(leg.symbol);
        if (currentPrice > 0) {
          leg.currentPrice = currentPrice;

          // Software fallback SL if price exceeds stop loss price by overrun tolerance
          const threshold = leg.stopLossPrice * (1 + config.slOverrunTolerance);
          if (currentPrice >= threshold) {
            console.warn(
              `[1DTE Monitor] 🚨 Price ($${currentPrice}) surpassed threshold ($${threshold.toFixed(2)}). Executing software fallback close for ${leg.symbol}...`
            );
            await closeLeg(client, leg, 'SL_FALLBACK_CLOSE');
            await saveOneDteState(state, state.date);

            if (notifier) {
              void notifier.notifyLegClosed({
                legType: leg.legType,
                symbol: leg.symbol,
                reason: 'SL_FALLBACK_CLOSE',
                exitPrice: leg.exitPrice ?? currentPrice,
                runningPnL: leg.entryPrice - (leg.exitPrice ?? currentPrice),
              });
            }
          }
        }
      }

      // 3. Profit target: bank the cycle once the combined gain reaches the configured share of the
      //    credit sold (sold 125 + 125 = 250 -> exit at 125 when PROFIT_TARGET_RATIO = 0.5).
      //    Only fires while at least one leg is still open, and only on complete price data.
      const gain = combinedGainPoints(state);
      const stillOpen = state.callLeg.status === 'open' || state.putLeg.status === 'open';
      if (stillOpen && gain !== null && targetPoints > 0 && gain >= targetPoints) {
        console.log(
          `[1DTE Monitor] 🎯 Profit target reached: ${gain.toFixed(2)} pts >= ${targetPoints.toFixed(2)} pts ` +
            `(${(config.profitTargetRatio * 100).toFixed(0)}% of $${state.totalCreditReceived.toFixed(2)} credit). Closing remaining legs...`
        );
        await closeRemainingLegs(client, state, 'PROFIT_TARGET_HIT', notifier);
        state.combinedPnLPoints = gain;
        state.status = 'closed';
        await saveOneDteState(state, state.date);

        if (notifier) {
          void notifier.notifyError(
            '1 DTE Profit Target Hit',
            new Error(`Combined gain ${gain.toFixed(2)} pts reached the ${targetPoints.toFixed(2)} pts target — cycle closed.`)
          );
        }
        break;
      }

      // If both legs closed, cycle complete
      if (state.callLeg.status === 'closed' && state.putLeg.status === 'closed') {
        console.log('[1DTE Monitor] ✅ Both legs closed. 1 DTE cycle resolved.');
        const finalGain = combinedGainPoints(state);
        if (finalGain !== null) state.combinedPnLPoints = finalGain;
        state.status = 'closed';
        await saveOneDteState(state, state.date);
        break;
      }
    } catch (err) {
      console.error(`[1DTE Monitor] Error during poll cycle: ${(err as Error).message}`);
    }

    await new Promise((r) => setTimeout(r, checkIntervalMs));
  }
}

async function closeLeg(
  client: CoinDCXClient,
  leg: OneDteLeg,
  reason: 'SL_FALLBACK_CLOSE' | 'MONITOR_WINDOW_ELAPSED' | 'PROFIT_TARGET_HIT'
): Promise<void> {
  console.log(`[1DTE Monitor] Closing ${leg.legType} (${leg.symbol}) via buy market order (reduceOnly)...`);
  try {
    const outcome = await client.placeOptionsOrder(
      leg.symbol,
      'buy',
      leg.quantity,
      'Market',
      undefined,
      '',
      '',
      undefined,
      true
    );
    leg.status = 'closed';
    leg.closeReason = reason;
    leg.exitPrice = outcome.limitPrice ?? leg.currentPrice;
    leg.exitOrderId = outcome.orderId;
    console.log(`[1DTE Monitor] ✅ Successfully closed ${leg.symbol} at $${leg.exitPrice?.toFixed(2)}.`);
  } catch (err) {
    console.error(`[1DTE Monitor] ❌ Failed to close ${leg.symbol}: ${(err as Error).message}`);
  }
}

async function closeRemainingLegs(
  client: CoinDCXClient,
  state: OneDtePositionState,
  reason: 'MONITOR_WINDOW_ELAPSED' | 'PROFIT_TARGET_HIT',
  notifier?: TelegramNotifier
): Promise<void> {
  for (const leg of [state.callLeg, state.putLeg]) {
    if (leg.status === 'open') {
      await closeLeg(client, leg, reason);
      if (notifier) {
        void notifier.notifyLegClosed({
          legType: leg.legType,
          symbol: leg.symbol,
          reason,
          exitPrice: leg.exitPrice ?? leg.currentPrice,
          runningPnL: leg.entryPrice - (leg.exitPrice ?? leg.currentPrice),
        });
      }
    }
  }
}
