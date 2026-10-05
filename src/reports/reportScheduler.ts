import { CoinDCXClient } from '../client';
import { AppConfig } from '../config';
import { appendAlert } from '../fileAlerter';
import { Notifier } from '../notifier';
import { getStateDir, loadStraddleState } from '../stateStore';
import { generateDailyReport } from './reportGenerator';
import { getReportsDir } from './reportPaths';
import { publishDailyReport } from './reportPublisher';
import fs from 'fs';
import path from 'path';

export interface ReportSchedulerHandle {
  readonly stop: () => void;
  readonly timerActive: boolean;
}

export function parseContractExpiryDate(symbol: string): string | null {
  const match = symbol.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-/i);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const monthStr = match[2].toUpperCase();
  const yearShort = match[3];

  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  const month = months[monthStr];
  if (!month) return null;
  return `20${yearShort}-${month}-${day}`;
}

/**
 * Calculates contract expiry time in ms.
 * CoinDCX options expire at 08:00 UTC (13:30 IST).
 */
export function getExpiryTimeMs(expiryDateStr: string, expiryHourUtc = 8): number {
  const [yyyy, mm, dd] = expiryDateStr.split('-').map(Number);
  return Date.UTC(yyyy, mm - 1, dd, expiryHourUtc, 0, 0, 0);
}

/**
 * Startup catch-up: scans all existing state files, checks if their expiry + delay has elapsed
 * and whether a report has already been generated. If missing, generates and publishes it.
 */
export async function runStartupReportCatchup(
  client: CoinDCXClient,
  config: AppConfig,
  notifier?: Notifier,
  now = new Date()
): Promise<string[]> {
  const stateDir = getStateDir();
  const reportsDir = getReportsDir();
  if (!fs.existsSync(stateDir)) return [];

  const generatedCycles: string[] = [];
  const delayMinutes = config.reportDelayMinutes ?? 15;
  const delayMs = delayMinutes * 60 * 1000;
  const nowMs = now.getTime();

  try {
    const files = (await fs.promises.readdir(stateDir))
      .filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'))
      .sort();

    for (const f of files) {
      const dateMatch = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
      if (!dateMatch) continue;
      const entryDate = dateMatch[1];
      const state = await loadStraddleState(entryDate);
      if (!state || !state.entryExecuted) continue;

      const callExpiry = parseContractExpiryDate(state.callLeg?.symbol || '');
      const putExpiry = parseContractExpiryDate(state.putLeg?.symbol || '');
      const expiryDateStr = callExpiry || putExpiry || entryDate;

      const reportPath = path.join(reportsDir, `${expiryDateStr}.md`);
      if (fs.existsSync(reportPath)) {
        // Already generated
        continue;
      }

      // Check if target expiry time + delayMs has elapsed
      const expiryMs = getExpiryTimeMs(expiryDateStr, config.dailyExpiryHourUTC ?? 8);
      if (nowMs >= expiryMs + delayMs) {
        console.log(`[ReportScheduler] Catching up ungenerated report for cycle ${expiryDateStr}...`);
        try {
          await generateDailyReport(expiryDateStr, { client, config, now });
          await publishDailyReport(expiryDateStr, {
            dryRun: config.dryRun,
            authorName: config.reportGitAuthorName,
            authorEmail: config.reportGitAuthorEmail,
            notifier,
          });
          generatedCycles.push(expiryDateStr);
        } catch (genErr) {
          console.error(`[ReportScheduler] Failed to catch up report for ${expiryDateStr}: ${(genErr as Error).message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[ReportScheduler] Error during startup catchup: ${(err as Error).message}`);
  }

  return generatedCycles;
}

/**
 * Initializes report scheduler:
 * 1. Runs startup catch-up immediately.
 * 2. Arm a timer for the next active straddle cycle if one is known.
 */
export function initReportScheduler(
  client: CoinDCXClient,
  config: AppConfig,
  notifier?: Notifier
): ReportSchedulerHandle {
  let timer: NodeJS.Timeout | null = null;
  let active = false;

  const scheduleNext = async () => {
    // 1. Catch up past cycles
    await runStartupReportCatchup(client, config, notifier);

    // 2. Determine next cycle expiry
    const stateDir = getStateDir();
    if (!fs.existsSync(stateDir)) return;

    try {
      const files = (await fs.promises.readdir(stateDir))
        .filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'))
        .sort()
        .reverse();

      for (const f of files) {
        const dateMatch = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
        if (!dateMatch) continue;
        const entryDate = dateMatch[1];
        const state = await loadStraddleState(entryDate);
        if (!state || !state.entryExecuted) continue;

        const callExpiry = parseContractExpiryDate(state.callLeg?.symbol || '');
        const putExpiry = parseContractExpiryDate(state.putLeg?.symbol || '');
        const expiryDateStr = callExpiry || putExpiry || entryDate;

        const delayMinutes = config.reportDelayMinutes ?? 15;
        const delayMs = delayMinutes * 60 * 1000;
        const expiryMs = getExpiryTimeMs(expiryDateStr, config.dailyExpiryHourUTC ?? 8);
        const reportTriggerMs = expiryMs + delayMs;
        const nowMs = Date.now();

        if (reportTriggerMs > nowMs) {
          const waitMs = reportTriggerMs - nowMs;
          const waitMin = (waitMs / 60000).toFixed(1);
          console.log(`[ReportScheduler] Armed daily report timer for cycle ${expiryDateStr} (in ${waitMin} minutes)`);

          active = true;
          timer = setTimeout(async () => {
            console.log(`[ReportScheduler] Timer fired: generating report for ${expiryDateStr}...`);
            try {
              await generateDailyReport(expiryDateStr, { client, config });
              await publishDailyReport(expiryDateStr, {
                dryRun: config.dryRun,
                authorName: config.reportGitAuthorName,
                authorEmail: config.reportGitAuthorEmail,
                notifier,
              });
            } catch (err) {
              const msg = `Scheduled report error for ${expiryDateStr}: ${(err as Error).message}`;
              console.error(`[ReportScheduler] 🚨 ${msg}`);
              appendAlert('report_publish_failed', msg);
            } finally {
              active = false;
            }
          }, waitMs);
          return;
        }
      }
    } catch (err) {
      console.error(`[ReportScheduler] Error scheduling next report: ${(err as Error).message}`);
    }
  };

  void scheduleNext();

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      active = false;
    },
    get timerActive() {
      return active;
    },
  };
}
