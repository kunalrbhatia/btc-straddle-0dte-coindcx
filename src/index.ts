import { CoinDCXClient } from './client';
import { config } from './config';
import { scheduleAtIST } from './scheduler';
import { executeShortStraddle } from './straddle';

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

  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken
  );

  // Check if user passed --now argument to run an immediate test
  const runImmediately = process.argv.includes('--now');

  if (runImmediately) {
    console.log('[Runner] "--now" argument detected. Executing straddle immediately...');
    try {
      await executeShortStraddle(client, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
    }
    return;
  }

  // Schedule to execute at 6:15 PM IST daily
  console.log(
    `[Runner] Scheduling straddle execution for ${config.scheduledHourIST}:${String(
      config.scheduledMinuteIST
    ).padStart(2, '0')} IST...`
  );

  scheduleAtIST(config.scheduledHourIST, config.scheduledMinuteIST, async () => {
    try {
      await executeShortStraddle(client, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Runner] Execution error: ${msg}`);
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
