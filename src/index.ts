import { CoinDCXClient } from './client';
import { config } from './config';
import { TelegramNotifier } from './notifier';
import { scheduleAtIST } from './scheduler';
import { getTodayDateStringIST, hasTodayExecuted, loadStraddleState } from './stateStore';
import { executeShortStraddle } from './straddle';
import { monitorStraddleRisk } from './riskManager';

async function main(): Promise<void> {
  console.log('==================================================');
  console.log('  CoinDCX BTC 0DTE ATM Straddle Automated Bot    ');
  console.log('==================================================');

  if (!config.apiKey || !config.apiSecret) {
    console.warn(
      '⚠️  WARNING: COINDCX_API_KEY or COINDCX_API_SECRET is missing in environment.'
    );
    console.warn('   Please configure them in your .env file before live trading.\n');
  }

  console.log(`[Config] Scheduled Time : ${config.scheduledHourIST}:${String(config.scheduledMinuteIST).padStart(2, '0')} IST`);
  console.log(`[Config] Order Quantity : ${config.orderQuantity} BTC`);
  console.log(`[Config] Leverage       : ${config.leverage}x`);
  console.log(`[Config] Strike Step    : ${config.strikeStep}`);
  console.log(`[Config] Margin Currency: ${config.marginCurrency}`);
  console.log(`[Config] Stop Loss Mult : ${config.riskConfig.stopLossMultiplier}x (+100%)`);
  console.log(`[Config] Profit Target  : ${config.riskConfig.profitTargetRatio * 100}% of combined credit`);
  console.log('==================================================\n');

  const notifier = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID
  );

  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken
  );

  const todayStr = getTodayDateStringIST();

  // Startup Reconciliation: Check if today has an open straddle from a prior run or crash
  try {
    const existingState = await loadStraddleState(todayStr);
    if (existingState && existingState.entryExecuted) {
      const hasOpenLeg = existingState.callLeg.status === 'open' || existingState.putLeg.status === 'open';
      if (hasOpenLeg && !existingState.resolvedScenario) {
        const reconcileMsg = `Found existing OPEN position for today (${todayStr})! Resuming risk monitor without re-entering.`;
        console.warn(`[Startup Reconciliation] ⚠️ ${reconcileMsg}`);
        void notifier.notifyReconciliation(reconcileMsg);

        // Resume monitoring
        void monitorStraddleRisk(client, existingState, config, notifier);
        return;
      } else {
        console.log(`[Startup Reconciliation] Position for today (${todayStr}) is already completed or resolved (${existingState.resolvedScenario || 'DONE'}).`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Startup Reconciliation] Error checking existing state: ${msg}`);
  }

  // Check if user passed --now argument to run an immediate execution
  const runImmediately = process.argv.includes('--now');

  if (runImmediately) {
    console.log('[Runner] "--now" argument detected.');
    
    // Safety check: require explicit ALLOW_INSTANT_EXECUTION=true flag
    if (process.env.ALLOW_INSTANT_EXECUTION !== 'true') {
      const refusalMsg = 'Refusing --now execution: ALLOW_INSTANT_EXECUTION=true is not set in environment. Set it explicitly to permit immediate manual execution.';
      console.error(`[Runner] 🛑 ${refusalMsg}`);
      void notifier.notifyError('--now execution guard', refusalMsg);
      return;
    }

    // Idempotency check: refuse if today has already executed
    const alreadyRun = await hasTodayExecuted(todayStr);
    if (alreadyRun) {
      const skipMsg = `Refusing --now execution: Straddle for today (${todayStr}) has already been executed!`;
      console.warn(`[Runner] ⚠️ ${skipMsg}`);
      void notifier.notifyError('--now idempotency guard', skipMsg);
      return;
    }

    console.log('[Runner] ALLOW_INSTANT_EXECUTION=true confirmed and today has not yet executed. Executing straddle immediately...');
    try {
      await executeShortStraddle(client, config, notifier);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
      void notifier.notifyError('Immediate execution', error);
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

      await executeShortStraddle(client, config, notifier);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
      void notifier.notifyError('Scheduled execution', error);
    }
  });

  const handleShutdown = (signal: string): void => {
    console.log(`\n[Runner] Received ${signal}. Shutting down safely.`);
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

void main();
