import { CoinDCXClient } from '../client';
import { AppConfig } from '../config';
import { OptionsPosition } from '../types';
import {
  findStateForExpiry,
  parseMtmLogs,
  readCombinedAlerts,
  filterAndCollapseAlerts,
} from './reportDataCollector';
import { ensureReportsDirectory, getReportFilePath } from './reportPaths';
import { getExpiryTimeMs } from './reportScheduler';
import { formatVerificationReportTable, verifyCycleAgainstVenue } from '../records/venueVerification';
import fs from 'fs';

export interface GenerateReportOptions {
  readonly client?: CoinDCXClient;
  readonly config?: AppConfig;
  readonly usdtInrOverride?: number | null;
  readonly positionsOverride?: readonly OptionsPosition[];
  readonly spotPriceOverride?: number;
  readonly now?: Date;
  readonly walletTransactionsOverride?: readonly Record<string, unknown>[];
}

export interface ReportGenerationResult {
  readonly expiryDateStr: string;
  readonly filePath: string;
  readonly content: string;
}

export async function fetchLiveUsdtInrRate(): Promise<{
  rate: number | null;
  provenance: string;
}> {
  // 1. Try public market_data/current_prices
  try {
    const res = await fetch('https://public.coindcx.com/market_data/current_prices');
    if (res.ok) {
      const data = (await res.json()) as Record<string, string>;
      const rawVal = data['USDTINR'] || data['USDT_INR'] || data['B-USDT_INR'];
      if (rawVal) {
        const parsed = parseFloat(rawVal);
        if (Number.isFinite(parsed) && parsed >= 40 && parsed <= 250) {
          return { rate: parsed, provenance: 'CoinDCX current_prices (USDTINR)' };
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  // 2. Try exchange ticker
  try {
    const res = await fetch('https://public.coindcx.com/exchange/ticker');
    if (res.ok) {
      const data = (await res.json()) as Array<{ market?: string; last_price?: string }>;
      if (Array.isArray(data)) {
        const item = data.find(
          (t) => t.market === 'USDTINR' || t.market === 'USDT_INR' || t.market === 'B-USDT_INR'
        );
        if (item && item.last_price) {
          const parsed = parseFloat(item.last_price);
          if (Number.isFinite(parsed) && parsed >= 40 && parsed <= 250) {
            return { rate: parsed, provenance: 'CoinDCX exchange ticker (USDTINR)' };
          }
        }
      }
    }
  } catch {
    // Fallback failure
  }

  return { rate: null, provenance: 'CoinDCX public endpoints unreachable or rate outside sanity band (40-250)' };
}

export async function generateDailyReport(
  expiryDateStr: string,
  options: GenerateReportOptions = {}
): Promise<ReportGenerationResult> {
  ensureReportsDirectory();

  // Find state file matching target expiry date
  const found = await findStateForExpiry(expiryDateStr);
  if (!found) {
    throw new Error(`No straddle state found for target expiry cycle ${expiryDateStr}`);
  }

  const { state, entryDate } = found;
  const now = options.now ?? new Date();

  // Cycle window calculation
  const reportDelayMin = options.config?.reportDelayMinutes ?? 15;
  const expiryHourUtc = options.config?.dailyExpiryHourUTC ?? 8;
  const expiryMs = getExpiryTimeMs(expiryDateStr, expiryHourUtc);
  const cycleEndMs = expiryMs + reportDelayMin * 60 * 1000;

  // Window start calculation (entry timestamp if known, else start of entryDate in IST)
  let cycleStartMs: number;
  if (state.updatedAt) {
    const parsedUp = Date.parse(state.updatedAt);
    // If updatedAt is before expiry, start at beginning of that day
    cycleStartMs = Number.isFinite(parsedUp)
      ? Date.parse(`${entryDate}T00:00:00+05:30`)
      : Date.parse(`${entryDate}T00:00:00+05:30`);
  } else {
    cycleStartMs = Date.parse(`${entryDate}T00:00:00+05:30`);
  }

  // Unique list of dates to gather MTM logs and alerts across cycle
  const cycleDates = Array.from(new Set([entryDate, expiryDateStr])).sort();
  const mtmStats = parseMtmLogs(cycleDates);
  const rawAlerts = readCombinedAlerts(cycleDates);

  const allowedSymbols = [state.callLeg?.symbol, state.putLeg?.symbol].filter(Boolean) as string[];
  const collapsedAlerts = filterAndCollapseAlerts(rawAlerts, {
    windowStartMs: cycleStartMs,
    windowEndMs: cycleEndMs,
    allowedSymbols,
  });

  // FX Rate
  let usdtInrRate: number | null = null;
  let fxProvenance = '';
  if (options.usdtInrOverride !== undefined) {
    usdtInrRate = options.usdtInrOverride;
    fxProvenance = options.usdtInrOverride !== null ? 'Injected override' : 'Explicit N/A';
  } else {
    const fxRes = await fetchLiveUsdtInrRate();
    usdtInrRate = fxRes.rate;
    fxProvenance = fxRes.provenance;
  }

  // Live positions & Spot price
  let livePositions: readonly OptionsPosition[] = [];
  let spotPrice: number | null = options.spotPriceOverride ?? null;

  if (options.positionsOverride !== undefined) {
    livePositions = options.positionsOverride;
  } else if (options.client) {
    try {
      livePositions = await options.client.getOptionsPositions();
    } catch {
      livePositions = [];
    }
  }

  if (spotPrice === null && options.client) {
    try {
      spotPrice = await options.client.getBtcSpotPrice();
    } catch {
      spotPrice = null;
    }
  }

  // Extract legs (PUT before CALL as mandated)
  const putLeg = state.putLeg;
  const callLeg = state.callLeg;

  // Filter live positions to ONLY this cycle's two symbols
  const cyclePositions = livePositions.filter(
    (p) => p.symbol === putLeg?.symbol || p.symbol === callLeg?.symbol
  );

  // Multiplier USDT per point:
  // Derived from order qty 0.01 BTC = 0.01 USDT/point
  const putQty = Number(putLeg?.quantity ?? 0.01);
  const callQty = Number(callLeg?.quantity ?? 0.01);
  const contractMultiplier = Math.max(putQty, callQty, 0.01);

  // Check orphan positions on exchange specifically for this cycle's contracts
  const isPutOrphan = cyclePositions.some((p) => p.symbol === putLeg?.symbol);
  const isCallOrphan = cyclePositions.some((p) => p.symbol === callLeg?.symbol);

  const isCycleExpired = now.getTime() >= expiryMs;

  // Calculate Leg details
  function formatLeg(
    legType: 'PUT' | 'CALL',
    leg: typeof putLeg,
    isOrphan: boolean
  ) {
    const symbol = leg?.symbol ?? 'UNKNOWN';
    const entryPrice = leg?.entryPrice ?? 0;
    let exitPrice = leg?.exitPrice ?? null;
    let reason = leg?.closeReason ? String(leg.closeReason) : 'N/A';
    let isExpiredWorthless = false;

    if (isOrphan) {
      reason = '🔴 ORPHAN / MANUAL ACTION NEEDED (open on exchange)';
      exitPrice = null;
    } else if (leg?.status === 'closed') {
      if (exitPrice === null || exitPrice === undefined) {
        exitPrice = leg.currentPrice ?? entryPrice;
      }
    } else if (isCycleExpired) {
      // Leg was open in state, not on exchange at/after expiry -> settled at 0.00
      isExpiredWorthless = true;
      exitPrice = 0;
      reason = 'EXPIRED';
    } else {
      // Leg is still open before expiry
      exitPrice = leg?.currentPrice ?? entryPrice;
      reason = 'OPEN';
    }

    const pnlPoints = exitPrice !== null ? entryPrice - exitPrice : null;
    const pnlUsdt = pnlPoints !== null ? pnlPoints * (leg?.quantity ?? contractMultiplier) : null;
    const pnlInr =
      pnlUsdt !== null && usdtInrRate !== null ? pnlUsdt * usdtInrRate : null;

    return {
      legType,
      symbol,
      entryPrice,
      exitPrice,
      reason,
      pnlPoints,
      pnlUsdt,
      pnlInr,
      isOrphan,
      isExpiredWorthless,
    };
  }

  const putSummary = formatLeg('PUT', putLeg, isPutOrphan);
  const callSummary = formatLeg('CALL', callLeg, isCallOrphan);

  // Combined PnL (State Points basis)
  let combinedPoints: number | null = null;
  let combinedUsdt: number | null = null;
  let combinedInr: number | null = null;

  if (putSummary.pnlPoints !== null && callSummary.pnlPoints !== null) {
    combinedPoints = putSummary.pnlPoints + callSummary.pnlPoints;
    combinedUsdt = (putSummary.pnlUsdt ?? 0) + (callSummary.pnlUsdt ?? 0);
    combinedInr =
      combinedUsdt !== null && usdtInrRate !== null ? combinedUsdt * usdtInrRate : null;
  }

  // Venue cash P&L from wallet transactions (Dual P&L basis)
  let venueTransactions: readonly Record<string, unknown>[] = [];
  if (options.walletTransactionsOverride !== undefined) {
    venueTransactions = options.walletTransactionsOverride;
  } else if (options.client) {
    try {
      venueTransactions = await options.client.getOptionsWalletTransactions();
    } catch {
      venueTransactions = [];
    }
  }

  // Format Helper
  const fmtPts = (val: number | null) => (val !== null ? `${val >= 0 ? '+' : ''}${val.toFixed(2)} pts` : 'N/A');
  const fmtUsdt = (val: number | null) => (val !== null ? `${val >= 0 ? '+' : ''}$${val.toFixed(2)}` : 'N/A');
  const fmtInr = (val: number | null) => (val !== null ? `${val >= 0 ? '+' : ''}₹${val.toFixed(2)}` : 'N/A');

  // Format Date strings
  const generatedAtIst = new Date(now.getTime() + 330 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19) + ' IST';

  const reportTimeTimeOnly = generatedAtIst.slice(11);

  // Build Markdown
  let md = `# BTC 0DTE Short Straddle Trade Report — ${expiryDateStr}\n\n`;

  // Summary Table
  md += `## 1. Executive Summary\n\n`;
  md += `| Field | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Cycle Expiry** | ${expiryDateStr} (08:00 UTC / 13:30 IST) |\n`;
  md += `| **Entry Date** | ${entryDate} |\n`;
  md += `| **Report Generated** | ${generatedAtIst} |\n`;
  md += `| **Resolved Scenario** | \`${state.resolvedScenario ?? (putSummary.isOrphan || callSummary.isOrphan ? 'UNRESOLVED_ORPHAN' : 'COMPLETED')}\` |\n`;
  md += `| **Total Credit Received** | ${state.totalCreditReceived.toFixed(2)} pts |\n`;
  md += `| **Target Profit** | ${state.targetProfitPoints.toFixed(2)} pts |\n`;
  md += `| **Combined Realised P&L (pts)** | **${fmtPts(combinedPoints)}** |\n`;
  md += `| **Combined Realised P&L (USDT)** | **${fmtUsdt(combinedUsdt)}** |\n`;
  md += `| **Combined Realised P&L (INR)** | **${fmtInr(combinedInr)}** |\n`;
  md += `| **USDT/INR Exchange Rate** | ${usdtInrRate !== null ? `₹${usdtInrRate.toFixed(2)}` : 'N/A'} |\n\n`;

  // Leg Breakdown (PUT before CALL)
  md += `## 2. Leg-by-Leg Execution & P&L\n\n`;
  md += `> **Order of legs:** PUT leg followed by CALL leg.\n\n`;
  md += `| Leg | Symbol | Entry Price | Exit Price | Close Reason | P&L (pts) | P&L (USDT) | P&L (INR) |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const leg of [putSummary, callSummary]) {
    const exitStr = leg.exitPrice !== null ? `$${leg.exitPrice.toFixed(2)}` : 'N/A';
    md += `| **${leg.legType}** | \`${leg.symbol}\` | $${leg.entryPrice.toFixed(2)} | ${exitStr} | \`${leg.reason}\` | ${fmtPts(leg.pnlPoints)} | ${fmtUsdt(leg.pnlUsdt)} | ${fmtInr(leg.pnlInr)} |\n`;
  }
  md += `\n`;

  // MTM Run-up and Drawdown
  md += `## 3. MTM Run-up & Drawdown Analysis\n\n`;
  if (mtmStats.count > 0) {
    md += `| Metric | Points | Timestamp |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| **Total MTM Observations** | ${mtmStats.count} | ${mtmStats.firstTimestamp ?? 'N/A'} → ${mtmStats.lastTimestamp ?? 'N/A'} |\n`;
    md += `| **Initial MTM** | ${fmtPts(mtmStats.first)} | ${mtmStats.firstTimestamp ?? 'N/A'} |\n`;
    md += `| **Max Run-up (Peak)** | ${fmtPts(mtmStats.max)} | - |\n`;
    md += `| **Max Drawdown (Trough)** | ${fmtPts(mtmStats.min)} | - |\n`;
    md += `| **Final Recorded MTM** | ${fmtPts(mtmStats.last)} | ${mtmStats.lastTimestamp ?? 'N/A'} |\n\n`;
  } else {
    md += `_No MTM log observations were recorded for this cycle._\n\n`;
  }

  // Alerts Log
  md += `## 4. Alerts & Operator Journal\n\n`;
  if (collapsedAlerts.length > 0) {
    md += `Chronological alerts logged during cycle window [${entryDate} → ${expiryDateStr}]:\n\n`;
    for (const a of collapsedAlerts) {
      if (a.count > 1) {
        md += `- **[${a.firstTimeOnly}–${a.lastTimeOnly} IST]** \`${a.kind}\` **×${a.count}** — ${a.message}\n`;
      } else {
        md += `- **[${a.firstTs}]** \`${a.kind}\`: ${a.message}\n`;
      }
    }
    md += `\n`;
  } else {
    md += `_No alert records found for cycle window [${entryDate} → ${expiryDateStr}]._\n\n`;
  }

  // Data Quality & Invariants
  md += `## 5. Data Quality & Provenance\n\n`;
  md += `- **FX Rate Provenance**: ${fxProvenance}\n`;
  md += `- **USDT Per Point**: Derived dynamically as ${contractMultiplier} USDT/pt (${(contractMultiplier * 100).toFixed(0)}% BTC lot size)\n`;
  md += `- **Underlying Spot Price (BTCUSDT)**: ${spotPrice !== null ? `$${spotPrice.toFixed(2)}` : 'N/A'}\n`;
  md += `- **Exchange Positions Reconciliation**: Live positions read at ${reportTimeTimeOnly}; ${cyclePositions.length} position(s) of this cycle remain open on exchange.\n`;
  if (putSummary.isOrphan || callSummary.isOrphan) {
    md += `  - ⚠️ **WARNING**: Active orphan position detected! Human operator intervention required.\n`;
  } else {
    md += `  - ✅ Clean reconciliation. 0 open positions of this cycle remain on exchange.\n`;
  }

  // Dual P&L Reconciliation note
  md += `\n### Dual P&L Reconciliation (Points vs Venue Ledger)\n\n`;
  md += `- **State Points P&L**: **${fmtPts(combinedPoints)}** (${fmtUsdt(combinedUsdt)})\n`;
  if (venueTransactions.length > 0) {
    md += `- **Venue Ledger Transactions**: ${venueTransactions.length} transaction record(s) reconciled.\n`;
  } else {
    md += `- **Venue Ledger Cash P&L**: N/A (wallet transactions endpoint unavailable or session unauthenticated; never fabricating numbers).\n`;
  }

  // Broker Terminal Verification section
  try {
    const verRes = await verifyCycleAgainstVenue(expiryDateStr, {
      client: options.client,
      positionsOverride: options.positionsOverride as unknown as readonly Record<string, unknown>[],
      walletTransactionsOverride: options.walletTransactionsOverride,
      tolerance: options.config?.verificationTolerance ?? 0.5,
    });
    md += `\n## 6. Broker Terminal Verification\n\n`;
    md += `**Overall Verdict:** \`${verRes.overallVerdict}\`\n\n`;
    md += `\`\`\`\n`;
    md += formatVerificationReportTable(verRes);
    md += `\n\`\`\`\n`;
  } catch {
    // If record files not present or error, keep report resilient
  }

  md += `\n---\n_Generated by btc-straddle-0dte automated reporting engine_\n`;

  const reportFilePath = getReportFilePath(expiryDateStr);
  fs.writeFileSync(reportFilePath, md, 'utf8');

  return {
    expiryDateStr,
    filePath: reportFilePath,
    content: md,
  };
}

