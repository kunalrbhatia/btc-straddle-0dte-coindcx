import { CoinDCXClient } from '../client';
import { TelegramNotifier } from '../notifier';
import { OneDteConfig } from './config';
import { OneDtePositionState, OneDteLeg } from './types';
import { saveOneDteState } from './stateStore';

export async function monitorOneDteRisk(
  client: CoinDCXClient,
  state: OneDtePositionState,
  config: OneDteConfig,
  notifier?: TelegramNotifier
): Promise<void> {
  console.log('==================================================');
  console.log('       1 DTE POSITION MONITORING ACTIVE           ');
  console.log(` Target Exit Time: ${new Date(state.targetExitUtcMs).toISOString()}`);
  console.log('==================================================');

  const checkIntervalMs = config.pollIntervalMs;

  while (state.status === 'active') {
    const nowMs = Date.now();

    // 1. Check if Scheduled Exit Time (5:45 PM IST next day) has arrived
    if (nowMs >= state.targetExitUtcMs) {
      console.log(
        `[1DTE Monitor] ⏰ Reached scheduled exit time (${config.exitHourIST}:${String(config.exitMinuteIST).padStart(2, '0')} IST). Closing remaining open legs...`
      );
      await closeRemainingLegs(client, state, 'MONITOR_WINDOW_ELAPSED', notifier);
      state.status = 'closed';
      await saveOneDteState(state, state.date);
      break;
    }

    // 2. Fetch live positions from CoinDCX
    try {
      const positions = await client.getOptionsPositions();
      const openVenueSymbols = new Set(
        positions
          .filter((p) => {
            const q = Number(p.qty ?? (p as Record<string, unknown>).quantity ?? 0);
            return Math.abs(q) > 0;
          })
          .map((p) => p.symbol)
      );

      // Check each leg
      for (const leg of [state.callLeg, state.putLeg]) {
        if (leg.status !== 'open') continue;

        // Has position vanished from venue? (e.g. SL hit on exchange)
        if (!openVenueSymbols.has(leg.symbol)) {
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

      // If both legs closed, cycle complete
      if (state.callLeg.status === 'closed' && state.putLeg.status === 'closed') {
        console.log('[1DTE Monitor] ✅ Both legs closed. 1 DTE cycle resolved.');
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
  reason: 'SL_FALLBACK_CLOSE' | 'MONITOR_WINDOW_ELAPSED'
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
  reason: 'MONITOR_WINDOW_ELAPSED',
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
