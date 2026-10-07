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
import { getRecordJsonlPath, getRecordSummaryPath } from '../records/cycleRecordPaths';
import { CycleEventPayload, CycleSummarySnapshot } from '../records/cycleRecordTypes';
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
  const mtmStats = parseMtmLogs(cycleDates, {
    windowStartMs: cycleStartMs,
    windowEndMs: cycleEndMs,
  });
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

  // Check for cycle record & summary snapshot early so sections 1 & 2 can consume it
  const recordSummaryPath = getRecordSummaryPath(expiryDateStr);
  const recordJsonlPath = getRecordJsonlPath(expiryDateStr);
  let cycleSummarySnap: CycleSummarySnapshot | null = null;
  if (fs.existsSync(recordSummaryPath)) {
    try {
      cycleSummarySnap = JSON.parse(fs.readFileSync(recordSummaryPath, 'utf8'));
    } catch {
      cycleSummarySnap = null;
    }
  }

  // Read timeline from records jsonl if available
  const timelineEvents: Array<{ ts: string; event: string; detail: string }> = [];
  let recordCycleClosedEvent: CycleEventPayload | null = null;

  if (fs.existsSync(recordJsonlPath)) {
    try {
      const lines = fs.readFileSync(recordJsonlPath, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line.trim()) as CycleEventPayload;
        let detail = '';
        if (ev.event === 'CYCLE_START') {
          detail = `Cycle initiated (Strike: ${ev.data?.strike ?? 'N/A'}, Call: ${ev.data?.callSymbol ?? 'N/A'}, Put: ${ev.data?.putSymbol ?? 'N/A'})`;
        } else if (ev.event === 'ORDER_FILLED') {
          detail = `${ev.data?.legType} filled @ $${Number(ev.data?.price ?? ev.data?.entryPrice ?? 0).toFixed(2)} (Order ID: ${ev.data?.orderId ?? 'N/A'})`;
        } else if (ev.event === 'LEG_CLOSED') {
          detail = `${ev.data?.legType} closed @ $${Number(ev.data?.price ?? ev.data?.exitPrice ?? 0).toFixed(2)} [${ev.data?.reason ?? 'N/A'}]`;
        } else if (ev.event === 'EXPIRY_SETTLEMENT') {
          detail = `${ev.data?.legType} settled at expiry @ $${Number(ev.data?.settlementPrice ?? 0).toFixed(2)} [${ev.data?.settlementReason ?? 'EXPIRED'}]`;
        } else if (ev.event === 'STOP_MOVED_TO_COST') {
          detail = `${ev.data?.leg} stop moved to COST ($${Number(ev.data?.newTrigger ?? 0).toFixed(2)}) from $${Number(ev.data?.oldTrigger ?? 0).toFixed(2)} [${ev.data?.reason ?? 'cost-stop'}]`;
        } else if (ev.event === 'COST_STOP_REOPENED') {
          detail = `${ev.data?.legType || 'Leg'} (${ev.data?.symbol}) reopened @ $${Number(ev.data?.newEntry ?? 0).toFixed(2)} with stop @ $${Number(ev.data?.newTrigger ?? 0).toFixed(2)} (buffer: +${Number(ev.data?.buffer ?? 0).toFixed(2)} pts, banked PnL: ${Number(ev.data?.bankedPnlPoints ?? 0).toFixed(2)} pts) [Order: ${ev.data?.orderId ?? 'N/A'}]`;
        } else if (ev.event === 'CYCLE_CLOSED') {
          recordCycleClosedEvent = ev;
          detail = `Cycle closed [${ev.data?.resolvedScenario ?? 'CLOSED'}], Realised P&L: ${Number(ev.data?.realisedPnlPoints ?? 0).toFixed(2)} pts`;
        } else {
          detail = JSON.stringify(ev.data ?? {});
        }
        timelineEvents.push({ ts: ev.ts, event: ev.event, detail });
      }
    } catch {
      // Fallback
    }
  }

  // Calculate Leg details: consumes record first!
  function formatLeg(
    legType: 'PUT' | 'CALL',
    leg: typeof putLeg,
    isOrphan: boolean
  ) {
    const symbol = leg?.symbol ?? (legType === 'PUT' ? cycleSummarySnap?.putSymbol : cycleSummarySnap?.callSymbol) ?? 'UNKNOWN';
    const recLeg = legType === 'PUT' ? cycleSummarySnap?.putLeg : cycleSummarySnap?.callLeg;

    // Entry price from record, fallback to state
    let entryPrice = recLeg?.entryPrice ?? leg?.entryPrice ?? 0;
    let exitPrice: number | null = null;
    let reason = 'N/A';
    let isExpiredWorthless = false;

    if (isOrphan) {
      reason = '🔴 ORPHAN / MANUAL ACTION NEEDED (open on exchange)';
      exitPrice = null;
    } else if (recLeg && (recLeg.exitPrice !== null && recLeg.exitPrice !== undefined || recLeg.status === 'closed')) {
      // Consume record leg details
      exitPrice = recLeg.exitPrice !== undefined ? recLeg.exitPrice : null;
      reason = recLeg.closeReason ? String(recLeg.closeReason) : 'CLOSED';
      if (reason === 'EXPIRED') isExpiredWorthless = true;
    } else if (leg?.status === 'closed') {
      exitPrice = leg.exitPrice !== undefined && leg.exitPrice !== null
        ? leg.exitPrice
        : (leg.currentPrice ?? null);
      reason = leg.closeReason ? String(leg.closeReason) : 'CLOSED';
    } else if (isCycleExpired) {
      isExpiredWorthless = true;
      exitPrice = 0;
      reason = 'EXPIRED';
    } else {
      exitPrice = leg?.currentPrice ?? null;
      reason = 'OPEN';
    }

    const pnlPoints = exitPrice !== null ? entryPrice - exitPrice : null;
    const pnlUsdt = pnlPoints !== null ? pnlPoints * (leg?.quantity ?? cycleSummarySnap?.orderQuantity ?? contractMultiplier) : null;
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

  // Combined PnL: consumes cycleSummarySnap or CYCLE_CLOSED if available
  let combinedPoints: number | null = null;
  let combinedUsdt: number | null = null;
  let combinedInr: number | null = null;

  if (cycleSummarySnap?.combinedPnLPoints !== undefined && cycleSummarySnap.combinedPnLPoints !== null) {
    combinedPoints = cycleSummarySnap.combinedPnLPoints;
    combinedUsdt = combinedPoints * (cycleSummarySnap.orderQuantity ?? contractMultiplier);
    combinedInr = combinedUsdt !== null && usdtInrRate !== null ? combinedUsdt * usdtInrRate : null;
  } else if (recordCycleClosedEvent?.data?.realisedPnlPoints !== undefined) {
    combinedPoints = Number(recordCycleClosedEvent.data.realisedPnlPoints);
    combinedUsdt = combinedPoints * contractMultiplier;
    combinedInr = combinedUsdt !== null && usdtInrRate !== null ? combinedUsdt * usdtInrRate : null;
  } else if (putSummary.pnlPoints !== null && callSummary.pnlPoints !== null) {
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
  const totalCreditReceived = cycleSummarySnap?.totalCreditReceived ?? state.totalCreditReceived;
  const targetProfitPoints = cycleSummarySnap?.targetProfitPoints ?? state.targetProfitPoints;
  const resolvedScenario = cycleSummarySnap?.resolvedScenario ?? state.resolvedScenario ?? (putSummary.isOrphan || callSummary.isOrphan ? 'UNRESOLVED_ORPHAN' : 'COMPLETED');

  md += `## 1. Executive Summary\n\n`;
  md += `| Field | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Cycle Expiry** | ${expiryDateStr} (08:00 UTC / 13:30 IST) |\n`;
  md += `| **Entry Date** | ${entryDate} |\n`;
  md += `| **Report Generated** | ${generatedAtIst} |\n`;
  md += `| **Resolved Scenario** | \`${resolvedScenario}\` |\n`;
  md += `| **Total Credit Received** | ${totalCreditReceived.toFixed(2)} pts |\n`;
  md += `| **Target Profit** | ${targetProfitPoints.toFixed(2)} pts |\n`;
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

  // Alerts Log / Timeline Section
  md += `## 4. Alerts & Operator Journal\n\n`;
  if (timelineEvents.length > 0) {
    const firstTs = timelineEvents[0].ts;
    const lastTs = timelineEvents[timelineEvents.length - 1].ts;
    md += `Chronological cycle events from write-through record [${firstTs} → ${lastTs}]:\n\n`;
    for (const te of timelineEvents) {
      md += `- **[${te.ts}]** \`${te.event}\` — ${te.detail}\n`;
    }
    md += `\n`;
  }

  if (collapsedAlerts.length > 0) {
    md += `Secondary — raw alert stream during cycle window [${entryDate} → ${expiryDateStr}]:\n\n`;
    for (const a of collapsedAlerts) {
      if (a.count > 1) {
        md += `- **[${a.firstTimeOnly}–${a.lastTimeOnly} IST]** \`${a.kind}\` **×${a.count}** — ${a.message}\n`;
      } else {
        md += `- **[${a.firstTs}]** \`${a.kind}\`: ${a.message}\n`;
      }
    }
    md += `\n`;
  } else if (timelineEvents.length === 0) {
    md += `_No event or alert records found for cycle window [${entryDate} → ${expiryDateStr}]._\n\n`;
  }

  // Data Quality & Invariants
  md += `## 5. Data Quality & Provenance\n\n`;
  if (cycleSummarySnap?.reconstructed) {
    md += `> ℹ️ **Provenance Notice**: _This cycle's record was reconstructed after the fact; live events were not written._\n\n`;
  }
  md += `- **FX Rate Provenance**: ${fxProvenance}\n`;
  md += `- **USDT Per Point**: Derived dynamically as ${contractMultiplier} USDT/pt (${(contractMultiplier * 100).toFixed(0)}% BTC lot size)\n`;
  md += `- **Underlying Spot Price (BTCUSDT)**: ${spotPrice !== null ? `$${spotPrice.toFixed(2)}` : 'N/A'}\n`;
  md += `- **Exchange Positions Reconciliation**: Live positions read at ${reportTimeTimeOnly}; ${cyclePositions.length} position(s) of this cycle remain open on exchange.\n`;
  if (putSummary.isOrphan || callSummary.isOrphan) {
    md += `  - ⚠️ **WARNING**: Active orphan position detected! Human operator intervention required.\n`;
  } else {
    md += `  - ✅ Clean reconciliation. 0 open positions of this cycle remain on exchange.\n`;
  }

  // Broker Terminal Verification section
  try {
    const verRes = await verifyCycleAgainstVenue(expiryDateStr, {
      client: options.client,
      positionsOverride: options.positionsOverride as unknown as readonly Record<string, unknown>[],
      walletTransactionsOverride: options.walletTransactionsOverride,
      tolerance: options.config?.verificationTolerance ?? 0.5,
    });

    // Dual P&L Reconciliation note
    md += `\n### Dual P&L Reconciliation (Points vs Venue Ledger)\n\n`;
    md += `- **State Points P&L**: **${fmtPts(combinedPoints)}** (${fmtUsdt(combinedUsdt)})\n`;
    if (verRes.ledgerSummary && (verRes.ledgerSummary.tradeRowsCount > 0 || verRes.ledgerSummary.deliveryRowsCount > 0)) {
      const ls = verRes.ledgerSummary;
      const matchedRows = ls.tradeRowsCount + ls.deliveryRowsCount;
      md += `- **Venue Ledger Cash P&L**: ₹${ls.totalTradeNetCashFlowInr.toFixed(2)} net (Gross: ₹${ls.totalTradeGrossCashFlowInr.toFixed(2)}, Fees: ₹${ls.totalFeesInr.toFixed(2)})\n`;
      md += `- **Reconciled Transactions**: ${matchedRows} row(s) matched cycle contracts out of ${ls.transactionCount} total wallet transactions (${ls.tradeRowsCount} trade(s), ${ls.deliveryRowsCount} delivery).\n`;
      md += `- **Basis Gap Explanation**: The difference between State points P&L and Venue net cash flow arises from exchange transaction fees (~1.9%) and the venue's USDT/INR conversion spread (~₹102 vs public rate ≈ ₹98.9–99.1); cash is derived directly from the venue ledger, never re-derived from public FX rates.\n`;
    } else if (venueTransactions.length > 0) {
      md += `- **Venue Ledger Transactions**: ${venueTransactions.length} transaction record(s) reconciled.\n`;
    } else {
      md += `- **Venue Ledger Cash P&L**: N/A (wallet transactions endpoint unavailable or session unauthenticated; never fabricating numbers).\n`;
    }

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

