import { CoinDCXClient } from '../client';
import { TelegramNotifier } from '../notifier';
import { scheduleAtIST } from '../scheduler';
import { acquireInstanceLock, InstanceLock } from '../instanceLock';
import { oneDteConfig } from './config';
import { findLatestOneDteState, loadOneDteState } from './stateStore';
import { executeOneDteEntry } from './executor';
import { monitorOneDteRisk } from './monitor';
import { getTodayDateStringIST } from '../stateStore';

async function main(): Promise<void> {
  console.log('==================================================');
  console.log('   CoinDCX BTC 1 DTE Options Selling Automated Bot');
  console.log('==================================================');

  // Single-instance lock specifically for 1 DTE bot
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock(`bot-1dte-${process.pid}-${Date.now()}`, 'bot-1dte.lock');
    console.log(`[1DTE Runner] Acquired instance lock (PID: ${lock.pid})`);
  } catch (lockErr) {
    console.error(`[1DTE Runner] 🛑 ${(lockErr as Error).message}`);
    process.exit(1);
  }

  console.log(`[1DTE Config] Entry Schedule : ${oneDteConfig.entryHourIST}:${String(oneDteConfig.entryMinuteIST).padStart(2, '0')} IST`);
  console.log(`[1DTE Config] Exit Schedule  : ${oneDteConfig.exitHourIST}:${String(oneDteConfig.exitMinuteIST).padStart(2, '0')} IST next day`);
  console.log(`[1DTE Config] Premium Range  : $${oneDteConfig.minPremium} - $${oneDteConfig.maxPremium}`);
  console.log(`[1DTE Config] Stop Loss Mult : ${oneDteConfig.stopLossMultiplier}x (2x premium)`);
  console.log(`[1DTE Config] Order Quantity : ${oneDteConfig.orderQuantity} BTC`);
  console.log(`[1DTE Config] Dry Run        : ${oneDteConfig.dryRun ? 'YES (Simulated)' : 'NO (Live Orders)'}`);
  console.log('==================================================\n');

  const notifier = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID
  );

  const client = new CoinDCXClient(
    oneDteConfig.apiKey,
    oneDteConfig.apiSecret,
    oneDteConfig.baseUrl,
    oneDteConfig.bearerToken,
    oneDteConfig.sessionTokenFile,
    oneDteConfig.dryRun,
    { fallbackConversionRate: oneDteConfig.conversionRate }
  );

  // Resume or monitor existing active state if any
  const latest = await findLatestOneDteState();
  if (latest && latest.state.status === 'active') {
    console.log(`[1DTE Runner] Resuming existing active 1 DTE cycle from ${latest.date}...`);
    await monitorOneDteRisk(client, latest.state, oneDteConfig, notifier);
  }

  // If RUN_ONCE=true or ALLOW_INSTANT_EXECUTION=true, run entry immediately
  if (process.env.RUN_ONCE === 'true' || process.env.ALLOW_INSTANT_EXECUTION === 'true') {
    console.log('[1DTE Runner] Instant execution triggered (RUN_ONCE=true)...');
    const state = await executeOneDteEntry(client, oneDteConfig, notifier);
    if (state && state.status === 'active') {
      await monitorOneDteRisk(client, state, oneDteConfig, notifier);
    }
    return;
  }

  // Schedule daily entry at 10:45 PM IST
  console.log(`[1DTE Scheduler] Arming daily entry schedule at ${oneDteConfig.entryHourIST}:${String(oneDteConfig.entryMinuteIST).padStart(2, '0')} IST...`);
  scheduleAtIST(oneDteConfig.entryHourIST, oneDteConfig.entryMinuteIST, async () => {
    const todayStr = getTodayDateStringIST();
    const existing = await loadOneDteState(todayStr);
    if (existing && existing.entryExecuted) {
      console.log(`[1DTE Runner] Cycle for ${todayStr} has already executed. Skipping duplicate entry.`);
      return;
    }

    const state = await executeOneDteEntry(client, oneDteConfig, notifier);
    if (state && state.status === 'active') {
      await monitorOneDteRisk(client, state, oneDteConfig, notifier);
    }
  });
}

main().catch((err) => {
  console.error(`[1DTE Runner] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
