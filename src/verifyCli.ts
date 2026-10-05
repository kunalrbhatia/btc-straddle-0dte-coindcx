#!/usr/bin/env node
import { CoinDCXClient } from './client';
import { config } from './config';
import { backfillHistoricalCycle } from './records/cycleBackfill';
import { formatVerificationReportTable, verifyCycleAgainstVenue } from './records/venueVerification';

function parseArgs(args: string[]): {
  cycle: string;
  json: boolean;
  tolerance?: number;
  backfill: boolean;
} {
  let cycle = '';
  let json = false;
  let tolerance: number | undefined;
  let backfill = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cycle' && i + 1 < args.length) {
      cycle = args[++i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--tolerance' && i + 1 < args.length) {
      tolerance = parseFloat(args[++i]);
    } else if (arg === '--backfill') {
      backfill = true;
    }
  }

  if (!cycle) {
    // Default to today in YYYY-MM-DD
    cycle = new Date().toISOString().slice(0, 10);
  }

  return { cycle, json, tolerance, backfill };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken,
    config.sessionTokenFile,
    config.dryRun,
    { fallbackConversionRate: String(config.conversionRate) }
  );

  if (args.backfill) {
    console.log(`[Verify] Backfilling historical record for cycle ${args.cycle}...`);
    await backfillHistoricalCycle({ expiryDateStr: args.cycle, overwrite: true });
  }

  const result = await verifyCycleAgainstVenue(args.cycle, {
    client,
    tolerance: args.tolerance ?? config.verificationTolerance,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatVerificationReportTable(result));
  }

  if (result.overallVerdict === 'FAILED') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[Verify] Fatal error:`, err);
  process.exit(1);
});
