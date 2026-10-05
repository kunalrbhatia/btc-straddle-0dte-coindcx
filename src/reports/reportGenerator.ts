import { CoinDCXClient } from '../client';
import { AppConfig } from '../config';
import { OptionsPosition } from '../types';
import {
  findStateForExpiry,
  parseMtmLogs,
  readCombinedAlerts,
} from './reportDataCollector';
import { ensureReportsDirectory, getReportFilePath } from './reportPaths';
import fs from 'fs';

export interface GenerateReportOptions {
  readonly client?: CoinDCXClient;
  readonly config?: AppConfig;
  readonly usdtInrOverride?: number | null;
  readonly positionsOverride?: readonly OptionsPosition[];
  readonly spotPriceOverride?: number;
  readonly now?: Date;
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

  // Unique list of dates to gather MTM logs and alerts across cycle
  const cycleDates = Array.from(new Set([entryDate, expiryDateStr])).sort();
  const mtmStats = parseMtmLogs(cycleDates);
  const alerts = readCombinedAlerts(cycleDates);

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

  // Multiplier USDT per point:
  // Derived from order qty 0.01 BTC = 0.01 USDT/point
  const putQty = Number(putLeg?.quantity ?? 0.01);
  const callQty = Number(callLeg?.quantity ?? 0.01);
  const contractMultiplier = Math.max(putQty, callQty, 0.01);

  // Check orphan positions on exchange
  const isPutOrphan = livePositions.some((p) => p.symbol === putLeg?.symbol);
  const isCallOrphan = livePositions.some((p) => p.symbol === callLeg?.symbol);

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
    } else {
      // Leg was open in state and is NOT on exchange at/after expiry -> expired worthless
      isExpiredWorthless = true;
      exitPrice = 0;
      reason = 'expired (not closed by the bot)';
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

  // Combined PnL
  let combinedPoints: number | null = null;
  let combinedUsdt: number | null = null;
  let combinedInr: number | null = null;

  if (putSummary.pnlPoints !== null && callSummary.pnlPoints !== null) {
    combinedPoints = putSummary.pnlPoints + callSummary.pnlPoints;
    combinedUsdt = (putSummary.pnlUsdt ?? 0) + (callSummary.pnlUsdt ?? 0);
    combinedInr =
      combinedUsdt !== null && usdtInrRate !== null ? combinedUsdt * usdtInrRate : null;
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
  if (alerts.length > 0) {
    md += `Chronological alerts logged during entry (${entryDate}) and expiry (${expiryDateStr}):\n\n`;
    for (const a of alerts) {
      md += `- **[${a.ts}]** \`${a.kind}\`: ${a.message}\n`;
    }
    md += `\n`;
  } else {
    md += `_No alert records found for dates ${cycleDates.join(', ')}._\n\n`;
  }

  // Data Quality & Invariants
  md += `## 5. Data Quality & Provenance\n\n`;
  md += `- **FX Rate Provenance**: ${fxProvenance}\n`;
  md += `- **USDT Per Point**: Derived dynamically as ${contractMultiplier} USDT/pt (${(contractMultiplier * 100).toFixed(0)}% BTC lot size)\n`;
  md += `- **Underlying Spot Price (BTCUSDT)**: ${spotPrice !== null ? `$${spotPrice.toFixed(2)}` : 'N/A'}\n`;
  md += `- **Exchange Positions Reconciliation**: ${livePositions.length} open position(s) detected at report time.\n`;
  if (putSummary.isOrphan || callSummary.isOrphan) {
    md += `  - ⚠️ **WARNING**: Active orphan position detected! Human operator intervention required.\n`;
  } else {
    md += `  - ✅ Clean reconciliation. No unmonitored positions remain open on exchange.\n`;
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
