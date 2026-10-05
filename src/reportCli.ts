import { CoinDCXClient } from './client';
import { config } from './config';
import { TelegramNotifier } from './notifier';
import { generateDailyReport } from './reports/reportGenerator';
import { publishDailyReport } from './reports/reportPublisher';
import { parseContractExpiryDate } from './reports/reportDataCollector';
import { getStateDir, loadStraddleState } from './stateStore';
import fs from 'fs';

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  let cycleDate: string | null = null;
  let stdoutMode = false;
  let dryRunMode = config.dryRun;
  let noPublish = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cycle' && i + 1 < args.length) {
      cycleDate = args[++i];
    } else if (arg === '--stdout') {
      stdoutMode = true;
    } else if (arg === '--dry-run') {
      dryRunMode = true;
    } else if (arg === '--no-publish') {
      noPublish = true;
    }
  }

  // If no cycle specified, infer latest cycle from state directory
  if (!cycleDate) {
    const stateDir = getStateDir();
    if (fs.existsSync(stateDir)) {
      const files = (await fs.promises.readdir(stateDir))
        .filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'))
        .sort()
        .reverse();

      for (const f of files) {
        const m = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
        if (m) {
          const entryDate = m[1];
          const state = await loadStraddleState(entryDate);
          if (state && state.entryExecuted) {
            const callExp = parseContractExpiryDate(state.callLeg?.symbol || '');
            const putExp = parseContractExpiryDate(state.putLeg?.symbol || '');
            cycleDate = callExp || putExp || entryDate;
            break;
          }
        }
      }
    }
  }

  if (!cycleDate) {
    console.error('No straddle state found to report on. Specify --cycle <YYYY-MM-DD>.');
    process.exit(1);
  }

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

  try {
    const result = await generateDailyReport(cycleDate, { client, config });

    if (stdoutMode) {
      console.log(result.content);
    } else {
      console.log(`Generated report: ${result.filePath}`);
    }

    if (!noPublish && !stdoutMode) {
      const pubResult = await publishDailyReport(cycleDate, {
        dryRun: dryRunMode,
        authorName: config.reportGitAuthorName,
        authorEmail: config.reportGitAuthorEmail,
        notifier,
      });
      console.log(pubResult.message);
    }
  } catch (err) {
    console.error(`Report generation failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

void runCli();
