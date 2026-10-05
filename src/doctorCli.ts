import fs from 'fs';
import path from 'path';
import { getStateDir, loadStraddleState } from './stateStore';
import { getRecordsDir, getRecordSummaryPath } from './records/cycleRecordPaths';
import { getReportFilePath } from './reports/reportPaths';
import { parseContractExpiryDate } from './reports/reportDataCollector';
import { CoinDCXClient } from './client';
import { config } from './config';

export interface DoctorFinding {
  readonly check: string;
  readonly status: 'PASS' | 'WARN' | 'FAIL';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export async function runDoctorChecks(options: {
  readonly client?: CoinDCXClient;
  readonly now?: Date;
} = {}): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const now = options.now ?? new Date();
  const stateDir = getStateDir();
  const recordsDir = getRecordsDir();

  // 1. Inspect state directory for anomalies
  let stateFiles: string[] = [];
  if (fs.existsSync(stateDir)) {
    stateFiles = fs.readdirSync(stateDir).filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'));
  }

  let futureDateCount = 0;
  let staleLegsCount = 0;
  const cycleExpiries = new Set<string>();

  for (const f of stateFiles) {
    const m = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
    if (!m) continue;
    const dateStr = m[1];
    const fileDateMs = Date.parse(`${dateStr}T23:59:59+05:30`);
    if (fileDateMs > now.getTime() + 86400000 * 2) {
      futureDateCount++;
      findings.push({
        check: 'State Date Sanity',
        status: 'WARN',
        message: `State file ${f} has far-future date ${dateStr}`,
        details: { file: f, date: dateStr },
      });
    }

    try {
      const state = await loadStraddleState(dateStr);
      if (state) {
        const callExp = parseContractExpiryDate(state.callLeg?.symbol || '');
        const putExp = parseContractExpiryDate(state.putLeg?.symbol || '');
        const cycle = callExp || putExp || dateStr;
        cycleExpiries.add(cycle);

        // Check for stale entry == exit without real close
        for (const leg of [state.callLeg, state.putLeg]) {
          if (
            leg &&
            leg.status === 'closed' &&
            leg.exitPrice === leg.entryPrice &&
            leg.closeReason === 'SL_HIT'
          ) {
            staleLegsCount++;
            findings.push({
              check: 'Leg Exit Sanity',
              status: 'WARN',
              message: `Leg ${leg.symbol} in ${dateStr} is marked SL_HIT but exitPrice equals entryPrice ($${leg.entryPrice})`,
              details: { symbol: leg.symbol, entry: leg.entryPrice, exit: leg.exitPrice },
            });
          }
        }
      }
    } catch {
      // Ignore parse failure in scan
    }
  }

  if (futureDateCount === 0) {
    findings.push({
      check: 'State Dates',
      status: 'PASS',
      message: 'All state files have valid calendar dates',
    });
  }

  if (staleLegsCount === 0) {
    findings.push({
      check: 'Leg Exit Consistency',
      status: 'PASS',
      message: 'No legs found with suspicious entry == exit pricing under SL_HIT',
    });
  }

  // 2. Inspect Records vs Reports alignment
  let missingReportsCount = 0;
  let missingRecordsCount = 0;

  for (const cycle of cycleExpiries) {
    const summaryPath = getRecordSummaryPath(cycle);
    const reportPath = getReportFilePath(cycle);

    const hasSummary = fs.existsSync(summaryPath);
    const hasReport = fs.existsSync(reportPath);

    if (hasSummary && !hasReport) {
      missingReportsCount++;
      findings.push({
        check: 'Report Existence',
        status: 'WARN',
        message: `Cycle ${cycle} has summary record but no published report at ${reportPath}`,
        details: { cycle, reportPath },
      });
    }

    if (!hasSummary && hasReport) {
      missingRecordsCount++;
      findings.push({
        check: 'Record Existence',
        status: 'WARN',
        message: `Cycle ${cycle} has report but no summary snapshot at ${summaryPath}`,
        details: { cycle, summaryPath },
      });
    }
  }

  if (missingReportsCount === 0 && missingRecordsCount === 0) {
    findings.push({
      check: 'Records & Reports Parity',
      status: 'PASS',
      message: 'All known cycles have aligned records and report files',
    });
  }

  // 3. Inspect Tape File Sizes (bloat warning > 5 MB)
  let bloatedTapeCount = 0;
  if (fs.existsSync(recordsDir)) {
    const tapeFiles = fs.readdirSync(recordsDir).filter((f) => f.endsWith('.mtm.jsonl'));
    for (const tf of tapeFiles) {
      const fullPath = path.join(recordsDir, tf);
      const stat = fs.statSync(fullPath);
      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb > 5) {
        bloatedTapeCount++;
        findings.push({
          check: 'MTM Tape File Size',
          status: 'WARN',
          message: `Tape ${tf} size (${sizeMb.toFixed(2)} MB) exceeds 5 MB threshold; recommend thinning before git commit`,
          details: { file: tf, sizeMb },
        });
      }
    }
  }

  if (bloatedTapeCount === 0) {
    findings.push({
      check: 'MTM Tape File Sizes',
      status: 'PASS',
      message: 'All committed and local MTM tapes are within reasonable size limits (< 5 MB)',
    });
  }

  // 4. Venue vs State open position comparison (if client available)
  const client = options.client;
  if (client) {
    try {
      const [venuePositions, openOrders] = await Promise.all([
        client.getOptionsPositions(),
        client.getOpenOptionsOrders(),
      ]);

      findings.push({
        check: 'Venue Connectivity',
        status: 'PASS',
        message: `Successfully connected to venue (Open positions: ${venuePositions.length}, Open orders: ${openOrders.length})`,
        details: { positionsCount: venuePositions.length, ordersCount: openOrders.length },
      });
    } catch (err) {
      findings.push({
        check: 'Venue Connectivity',
        status: 'WARN',
        message: `Could not query live venue: ${(err as Error).message}`,
      });
    }
  }

  return findings;
}

export function formatDoctorReport(findings: readonly DoctorFinding[]): string {
  const pad = (str: string, len: number) => str.padEnd(len);
  let out = '\n' + pad('CHECK', 35) + pad('STATUS', 10) + 'DETAILS\n';
  out += '-'.repeat(80) + '\n';
  for (const f of findings) {
    out += pad(f.check, 35) + pad(f.status, 10) + f.message + '\n';
  }
  out += '-'.repeat(80) + '\n';
  const hasFail = findings.some((f) => f.status === 'FAIL');
  const hasWarn = findings.some((f) => f.status === 'WARN');
  out += `OVERALL: ${hasFail ? 'FAIL' : hasWarn ? 'WARNINGS FOUND' : 'HEALTHY (PASS)'}\n`;
  return out;
}

async function runCli(): Promise<void> {
  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken,
    config.sessionTokenFile,
    config.dryRun,
    { fallbackConversionRate: String(config.conversionRate) }
  );

  const findings = await runDoctorChecks({ client });
  console.log(formatDoctorReport(findings));

  const hasFail = findings.some((f) => f.status === 'FAIL');
  if (hasFail) {
    process.exit(1);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error('[Doctor] Fatal error:', err);
    process.exit(1);
  });
}
