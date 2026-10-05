import { CoinDCXClient } from './client';
import { config } from './config';
import { TelegramNotifier } from './notifier';
import { scheduleAtIST } from './scheduler';
import { findLatestStraddleState, getTodayDateStringIST, hasTodayExecuted, hasUnresolvedOpenLeg, loadStraddleState } from './stateStore';
import { executeShortStraddle } from './straddle';
import { monitorStraddleRisk } from './riskManager';
import { reconcileAndResurrectState, rearmStopOrderIfMissing } from './reconciliation';
import { acquireInstanceLock, InstanceLock } from './instanceLock';
import { initReportScheduler } from './reports/reportScheduler';

async function main(): Promise<void> {
  console.log('==================================================');
  console.log('  CoinDCX BTC 0DTE ATM Straddle Automated Bot    ');
  console.log('==================================================');

  // Acquire single-instance lock to ensure only one bot instance manages positions
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock();
    console.log(`[Runner] Acquired instance lock (PID: ${lock.pid}, ID: ${lock.instanceId})`);
  } catch (lockErr) {
    console.error(`[Runner] 🛑 ${(lockErr as Error).message}`);
    process.exit(1);
  }

  if (!config.apiKey || !config.apiSecret) {
    console.warn(
      '⚠️  WARNING: COINDCX_API_KEY or COINDCX_API_SECRET is missing in environment.'
    );
    console.warn('   Please configure them in your .env file before live trading.\n');
  }

  if (config.dryRun) {
    console.log('🛡️  DRY_RUN=true is enabled! All order placement and cancellations will be simulated.\n');
  }

  console.log(`[Config] Scheduled Time : ${config.scheduledHourIST}:${String(config.scheduledMinuteIST).padStart(2, '0')} IST`);
  console.log(`[Config] Daily Expiry UTC: ${config.dailyExpiryHourUTC}:00 UTC`);
  console.log(`[Config] Order Quantity : ${config.orderQuantity} BTC`);
  console.log(`[Config] Leverage       : ${config.leverage}x`);
  console.log(`[Config] Strike Step    : ${config.strikeStep}`);
  console.log(`[Config] Margin Currency: ${config.marginCurrency}`);
  console.log(`[Config] Stop Loss Mult : ${config.riskConfig.stopLossMultiplier}x (+100%)`);
  console.log(`[Config] Profit Target  : ${config.riskConfig.profitTargetRatio * 100}% of combined credit`);
  console.log(`[Config] Report Delay   : ${config.reportDelayMinutes ?? 15} min post-expiry (target: ${(config.dailyExpiryHourUTC ?? 8) + 5}:30 + ${config.reportDelayMinutes ?? 15}m IST)`);
  console.log('==================================================\n');

  const notifier = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID
  );

  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken,
    config.sessionTokenFile,
    config.dryRun,
    { fallbackConversionRate: String(config.conversionRate) }
  );

  // Initialize daily trade report scheduler (runs startup catch-up & sets expiry timer)
  try {
    initReportScheduler(client, config, notifier);
  } catch (schedErr) {
    console.error(`[Runner] Failed to initialize report scheduler: ${(schedErr as Error).message}`);
  }

  const todayStr = getTodayDateStringIST();

  // Startup Reconciliation: Check if exchange or local state has an open straddle from a prior run or crash
  //
  // ⚠️ Resuming a position must NOT consume the day's entry. This block used to
  // `return` after starting the monitor, so any restart landing mid-cycle left the
  // process in monitor-only mode with the scheduler never armed — which is exactly
  // what happened on 2026-10-05 (PM2 `cron_restart` 30 13 * * * == the 13:30 IST
  // expiry, so the restart always lands on a live cycle) and silently cost that
  // day's trade. We now always fall through to the scheduler; opening a second
  // straddle is prevented by the unresolved-position guard inside the scheduled
  // callback, not by skipping the schedule.
  try {
    const reconciled = await reconcileAndResurrectState(client, config, notifier);
    if (reconciled && reconciled.state) {
      const stateToResume = reconciled.state;
      const hasOpenLeg = stateToResume.callLeg.status === 'open' || stateToResume.putLeg.status === 'open';
      if (hasOpenLeg && !stateToResume.resolvedScenario) {
        const reconcileMsg = reconciled.resurrected
          ? `Adopted/Resurrected OPEN position from exchange! Resuming risk monitor without re-entering.`
          : `Found existing OPEN position (${stateToResume.date})! Resuming risk monitor without re-entering.`;
        console.warn(`[Startup Reconciliation] ⚠️ ${reconcileMsg}`);
        void notifier.notifyReconciliation(reconcileMsg);

        // Re-arm any missing venue stop orders on startup (naked-leg risk mitigation)
        try {
          const openOrders = await client.getOpenOptionsOrders();
          if (stateToResume.callLeg.status === 'open' && stateToResume.callLeg.confirmedOpen) {
            await rearmStopOrderIfMissing(client, stateToResume.callLeg, openOrders, config, undefined, notifier);
          }
          if (stateToResume.putLeg.status === 'open' && stateToResume.putLeg.confirmedOpen) {
            await rearmStopOrderIfMissing(client, stateToResume.putLeg, openOrders, config, undefined, notifier);
          }
        } catch (rearmErr) {
          console.warn(`[Startup Reconciliation] Failed to verify/rearm stops on startup: ${(rearmErr as Error).message}`);
        }

        // Resume monitoring. Deliberately no early return: the daily scheduler below
        // still has to be armed for this process to trade again.
        void monitorStraddleRisk(client, stateToResume, config, notifier);
      }
    } else {
      // Fallback check on today's local state file
      const existingState = await loadStraddleState(todayStr);
      if (existingState && existingState.entryExecuted) {
        const hasOpenLeg = existingState.callLeg.status === 'open' || existingState.putLeg.status === 'open';
        if (hasOpenLeg && !existingState.resolvedScenario) {
          const reconcileMsg = `Found existing OPEN position for today (${todayStr})! Resuming risk monitor without re-entering.`;
          console.warn(`[Startup Reconciliation] ⚠️ ${reconcileMsg}`);
          void notifier.notifyReconciliation(reconcileMsg);

          // Re-arm any missing venue stop orders on startup
          try {
            const openOrders = await client.getOpenOptionsOrders();
            if (existingState.callLeg.status === 'open' && existingState.callLeg.confirmedOpen) {
              await rearmStopOrderIfMissing(client, existingState.callLeg, openOrders, config, undefined, notifier);
            }
            if (existingState.putLeg.status === 'open' && existingState.putLeg.confirmedOpen) {
              await rearmStopOrderIfMissing(client, existingState.putLeg, openOrders, config, undefined, notifier);
            }
          } catch (rearmErr) {
            console.warn(`[Startup Reconciliation] Failed to verify/rearm stops on startup: ${(rearmErr as Error).message}`);
          }

          // Resume monitoring — scheduler stays armed (see note above).
          void monitorStraddleRisk(client, existingState, config, notifier);
        } else {
          console.log(`[Startup Reconciliation] Position for today (${todayStr}) is already completed or resolved (${existingState.resolvedScenario || 'DONE'}).`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Startup Reconciliation] Error checking existing state: ${msg}`);
  }

  // Check if user passed --now argument or RUN_ONCE=true to run a single cycle
  const runImmediately = process.argv.includes('--now') || process.env.RUN_ONCE === 'true';

  if (runImmediately) {
    console.log('[Runner] Single cycle execution mode detected.');
    
    // Safety check: require explicit ALLOW_INSTANT_EXECUTION=true flag (unless dryRun is active)
    if (!config.dryRun && process.env.ALLOW_INSTANT_EXECUTION !== 'true') {
      const refusalMsg = 'Refusing immediate execution: ALLOW_INSTANT_EXECUTION=true is not set in environment. Set it explicitly or use DRY_RUN=true.';
      console.error(`[Runner] 🛑 ${refusalMsg}`);
      void notifier.notifyError('Execution guard', refusalMsg);
      lock.release();
      return;
    }

    // Idempotency check: refuse if today has already executed (bypassable if dryRun)
    const alreadyRun = await hasTodayExecuted(todayStr);
    if (alreadyRun && !config.dryRun) {
      const skipMsg = `Refusing execution: Straddle for today (${todayStr}) has already been executed!`;
      console.warn(`[Runner] ⚠️ ${skipMsg}`);
      void notifier.notifyError('Idempotency guard', skipMsg);
      lock.release();
      return;
    }

    // Open-position guard: an unresolved live leg must not be joined by a second straddle.
    // (This replaces the protection the removed early `return` used to give.)
    const trackingForInstant = await findLatestStraddleState();
    if (hasUnresolvedOpenLeg(trackingForInstant?.state)) {
      const guardMsg =
        `Refusing immediate execution: state (${trackingForInstant!.date}) still tracks an unresolved ` +
        `OPEN leg. Resolve or expire it first — refusing to double exposure.`;
      console.error(`[Runner] 🛑 ${guardMsg}`);
      void notifier.notifyError('Open-position guard', guardMsg);
      lock.release();
      return;
    }

    console.log('[Runner] Executing straddle cycle...');
    try {
      await executeShortStraddle(client, config, notifier);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
      void notifier.notifyError('Single cycle execution', error);
    } finally {
      lock.release();
    }
    return;
  }

  // Daily Scheduler at IST
  console.log(
    `[Runner] Scheduling straddle execution for ${config.scheduledHourIST}:${String(
      config.scheduledMinuteIST
    ).padStart(2, '0')} IST...`
  );

  scheduleAtIST(config.scheduledHourIST, config.scheduledMinuteIST, async () => {
    const currentDayStr = getTodayDateStringIST();
    try {
      // Idempotency guard: prevent duplicate entry if already executed today
      const alreadyExecuted = await hasTodayExecuted(currentDayStr);
      if (alreadyExecuted) {
        console.warn(`[Scheduler] ⚠️ Straddle for today (${currentDayStr}) has already executed. Skipping duplicate entry.`);
        return;
      }

      // Open-position guard: a resumed/restarted process may still be managing an
      // unresolved leg. Entering now would double the exposure, so skip the day's
      // entry and say so loudly (silence here is how 2026-10-05 was lost).
      const tracking = await findLatestStraddleState();
      if (hasUnresolvedOpenLeg(tracking?.state)) {
        const guardMsg =
          `Skipping entry for ${currentDayStr}: state (${tracking!.date}) still tracks an unresolved OPEN ` +
          `leg that is being monitored. No new straddle opened.`;
        console.warn(`[Scheduler] ⚠️ ${guardMsg}`);
        void notifier.notifyError('Scheduler open-position guard', guardMsg);
        return;
      }

      await executeShortStraddle(client, config, notifier);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
      void notifier.notifyError('Scheduled execution', error);
    }
  });

  const handleShutdown = (signal: string): void => {
    console.log(`\n[Runner] Received ${signal}. Shutting down safely.`);
    lock.release();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('exit', () => lock.release());
}

void main();

