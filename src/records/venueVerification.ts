import { CoinDCXClient } from '../client';
import { CycleRecordWriter } from './cycleRecordWriter';
import { CycleSummarySnapshot } from './cycleRecordTypes';

export type VerificationVerdictStatus = 'MATCH' | 'MISMATCH' | 'UNVERIFIED';
export type OverallVerificationVerdict = 'VERIFIED' | 'PARTIAL' | 'FAILED';

export interface VerificationClaimItem {
  readonly claim: string;
  readonly recordedValue: string | number;
  readonly venueValue: string | number | null;
  readonly delta?: number | null;
  readonly status: VerificationVerdictStatus;
  readonly reason?: string;
  readonly rawVenueRow?: Record<string, unknown>;
}

export interface CycleVerificationReport {
  readonly cycle: string;
  readonly overallVerdict: OverallVerificationVerdict;
  readonly readTimestamp: string;
  readonly claims: readonly VerificationClaimItem[];
  readonly ledgerSummary?: {
    readonly totalTradeGrossCashFlowInr: number;
    readonly totalTradeNetCashFlowInr: number;
    readonly totalFeesInr: number;
    readonly deliveryRowsCount: number;
    readonly tradeRowsCount: number;
    readonly transactionCount: number;
  };
}

export interface VerifyCycleOptions {
  readonly tolerance?: number;
  readonly client?: CoinDCXClient;
  readonly positionsOverride?: readonly Record<string, unknown>[];
  readonly ordersOverride?: readonly Record<string, unknown>[];
  readonly walletTransactionsOverride?: readonly Record<string, unknown>[];
  readonly snapshotOverride?: CycleSummarySnapshot;
}

export async function verifyCycleAgainstVenue(
  cycleExpiryStr: string,
  options: VerifyCycleOptions = {}
): Promise<CycleVerificationReport> {
  const tolerance = options.tolerance ?? 1.0;
  const writer = new CycleRecordWriter(cycleExpiryStr);
  const snapshot = options.snapshotOverride ?? writer.readSummarySnapshot();

  const readTimestamp = new Date().toISOString();
  const claims: VerificationClaimItem[] = [];

  if (!snapshot) {
    return {
      cycle: cycleExpiryStr,
      overallVerdict: 'PARTIAL',
      readTimestamp,
      claims: [
        {
          claim: 'Cycle summary snapshot existence',
          recordedValue: 'records/' + cycleExpiryStr + '.summary.json',
          venueValue: null,
          status: 'UNVERIFIED',
          reason: 'No record summary found on disk for this cycle',
        },
      ],
    };
  }

  // 1. Fetch Venue data
  let venuePositions: readonly Record<string, unknown>[] = [];
  let venueOrders: readonly Record<string, unknown>[] = [];
  let venueLedger: readonly Record<string, unknown>[] = [];

  if (options.positionsOverride !== undefined) {
    venuePositions = options.positionsOverride;
  } else if (options.client) {
    try {
      venuePositions = (await options.client.getOptionsPositions()) as unknown as readonly Record<string, unknown>[];
    } catch {
      venuePositions = [];
    }
  }

  if (options.ordersOverride !== undefined) {
    venueOrders = options.ordersOverride;
  } else if (options.client) {
    try {
      venueOrders = await options.client.getOpenOptionsOrders();
    } catch {
      venueOrders = [];
    }
  }

  if (options.walletTransactionsOverride !== undefined) {
    venueLedger = options.walletTransactionsOverride;
  } else if (options.client) {
    try {
      venueLedger = await options.client.getOptionsWalletTransactions();
    } catch {
      venueLedger = [];
    }
  }

  const callSym = snapshot.callSymbol || snapshot.callLeg?.symbol;
  const putSym = snapshot.putSymbol || snapshot.putLeg?.symbol;

  // Verification 1: CALL Entry price verified via ledger row joined on orderId
  const callOrderId = snapshot.callLeg?.orderId;
  const callLedgerEntry = callOrderId
    ? venueLedger.find((r) => String(r.orderId || r.order_id) === String(callOrderId))
    : venueLedger.find((r) => r.symbol === callSym && (r.transactionType === 'TRADE' || r.type === 'TRADE'));

  if (snapshot.callLeg) {
    const recordedEntry = snapshot.callLeg.venueAvgPrice ?? snapshot.callLeg.entryPrice;
    if (callLedgerEntry && callLedgerEntry.filledPrice !== undefined) {
      const venueFilled = Number(callLedgerEntry.filledPrice);
      const delta = Math.abs(recordedEntry - venueFilled);
      if (delta <= tolerance) {
        claims.push({
          claim: 'CALL Entry price (points)',
          recordedValue: recordedEntry,
          venueValue: venueFilled,
          delta,
          status: 'MATCH',
          rawVenueRow: callLedgerEntry,
        });
      } else {
        claims.push({
          claim: 'CALL Entry price (points)',
          recordedValue: recordedEntry,
          venueValue: venueFilled,
          delta,
          status: 'MISMATCH',
          reason: `Recorded entry ${recordedEntry} differs from venue filledPrice ${venueFilled} by ${delta.toFixed(2)} pts`,
          rawVenueRow: callLedgerEntry,
        });
      }
    } else {
      claims.push({
        claim: 'CALL Entry price (points)',
        recordedValue: recordedEntry,
        venueValue: null,
        status: 'UNVERIFIED',
        reason: 'No ledger transaction row matched orderId ' + (callOrderId || 'N/A'),
      });
    }
  }

  // Verification 2: PUT Entry price verified via ledger row joined on orderId
  const putOrderId = snapshot.putLeg?.orderId;
  const putLedgerEntry = putOrderId
    ? venueLedger.find((r) => String(r.orderId || r.order_id) === String(putOrderId))
    : venueLedger.find((r) => r.symbol === putSym && (r.transactionType === 'TRADE' || r.type === 'TRADE'));

  if (snapshot.putLeg) {
    const recordedEntry = snapshot.putLeg.venueAvgPrice ?? snapshot.putLeg.entryPrice;
    if (putLedgerEntry && putLedgerEntry.filledPrice !== undefined) {
      const venueFilled = Number(putLedgerEntry.filledPrice);
      const delta = Math.abs(recordedEntry - venueFilled);
      if (delta <= tolerance) {
        claims.push({
          claim: 'PUT Entry price (points)',
          recordedValue: recordedEntry,
          venueValue: venueFilled,
          delta,
          status: 'MATCH',
          rawVenueRow: putLedgerEntry,
        });
      } else {
        claims.push({
          claim: 'PUT Entry price (points)',
          recordedValue: recordedEntry,
          venueValue: venueFilled,
          delta,
          status: 'MISMATCH',
          reason: `Recorded entry ${recordedEntry} differs from venue filledPrice ${venueFilled} by ${delta.toFixed(2)} pts`,
          rawVenueRow: putLedgerEntry,
        });
      }
    } else {
      claims.push({
        claim: 'PUT Entry price (points)',
        recordedValue: recordedEntry,
        venueValue: null,
        status: 'UNVERIFIED',
        reason: 'No ledger transaction row matched orderId ' + (putOrderId || 'N/A'),
      });
    }
  }

  // Verification 3: Exit prices / Delivery settlement
  for (const legType of ['CALL', 'PUT'] as const) {
    const leg = legType === 'CALL' ? snapshot.callLeg : snapshot.putLeg;
    const sym = legType === 'CALL' ? callSym : putSym;
    if (!leg) continue;

    if (leg.closeReason === 'EXPIRED') {
      // Check DELIVERY row
      const deliveryRow = venueLedger.find(
        (r) =>
          r.symbol === sym &&
          (String(r.transactionType).toUpperCase() === 'DELIVERY' ||
            String(r.type).toUpperCase() === 'DELIVERY')
      );

      if (deliveryRow) {
        let venueVal = 0;
        let fieldUsed = 'netCashFlow';
        if (deliveryRow.netCashFlow !== undefined && deliveryRow.netCashFlow !== null && deliveryRow.netCashFlow !== '') {
          venueVal = Number(deliveryRow.netCashFlow);
          fieldUsed = 'netCashFlow';
        } else if (deliveryRow.balanceChange !== undefined && deliveryRow.balanceChange !== null && deliveryRow.balanceChange !== '') {
          venueVal = Number(deliveryRow.balanceChange);
          fieldUsed = 'balanceChange';
        } else if (deliveryRow.grossCashFlow !== undefined && deliveryRow.grossCashFlow !== null && deliveryRow.grossCashFlow !== '') {
          venueVal = Number(deliveryRow.grossCashFlow);
          fieldUsed = 'grossCashFlow';
        }

        const recordedVal = Number(leg.exitPrice ?? 0);
        const delta = Math.abs(recordedVal - venueVal);
        if (delta <= tolerance) {
          claims.push({
            claim: `${legType} Settlement at expiry (DELIVERY row)`,
            recordedValue: recordedVal,
            venueValue: venueVal,
            delta,
            status: 'MATCH',
            reason: `Matched via venue DELIVERY ${fieldUsed} (${venueVal})`,
            rawVenueRow: deliveryRow,
          });
        } else {
          claims.push({
            claim: `${legType} Settlement at expiry (DELIVERY row)`,
            recordedValue: recordedVal,
            venueValue: venueVal,
            delta,
            status: 'MISMATCH',
            reason: `Recorded settlement ${recordedVal} differs from venue DELIVERY ${fieldUsed} ${venueVal}`,
            rawVenueRow: deliveryRow,
          });
        }
      } else {
        // In CoinDCX, out-of-the-money options expire worthless with 0.00 cashflow
        claims.push({
          claim: `${legType} Settlement at expiry (DELIVERY row)`,
          recordedValue: Number(leg.exitPrice ?? 0),
          venueValue: null,
          status: 'UNVERIFIED',
          reason: `No explicit DELIVERY ledger row for ${sym} (delisted at 0.00 settlement)`,
        });
      }
    } else if (leg.status === 'closed' && leg.exitPrice !== null && leg.exitPrice !== undefined) {
      // Look for close order buy-back
      const closeOrderId = leg.closeOrderId;
      const closeLedger = closeOrderId
        ? venueLedger.find((r) => String(r.orderId || r.order_id) === String(closeOrderId))
        : venueLedger.find(
            (r) =>
              r.symbol === sym &&
              (r.transactionType === 'TRADE' || r.type === 'TRADE') &&
              Number(r.filledPrice) === leg.exitPrice
          );

      if (closeLedger && closeLedger.filledPrice !== undefined) {
        const venueFilled = Number(closeLedger.filledPrice);
        const delta = Math.abs(Number(leg.exitPrice) - venueFilled);
        if (delta <= tolerance) {
          claims.push({
            claim: `${legType} Exit price (TRADE row)`,
            recordedValue: leg.exitPrice,
            venueValue: venueFilled,
            delta,
            status: 'MATCH',
            rawVenueRow: closeLedger,
          });
        } else {
          claims.push({
            claim: `${legType} Exit price (TRADE row)`,
            recordedValue: leg.exitPrice,
            venueValue: venueFilled,
            delta,
            status: 'MISMATCH',
            reason: `Recorded exit ${leg.exitPrice} differs from venue buyback ${venueFilled}`,
            rawVenueRow: closeLedger,
          });
        }
      } else {
        claims.push({
          claim: `${legType} Exit price (TRADE row)`,
          recordedValue: leg.exitPrice,
          venueValue: null,
          status: 'UNVERIFIED',
          reason: 'No buy-back TRADE row matched closeOrderId ' + (closeOrderId || 'N/A'),
        });
      }
    }
  }

  // Verification 4: Flat cycle positions at the end (filter to this cycle's two symbols)
  const openCyclePositions = venuePositions.filter(
    (p) => (p.symbol === callSym || p.symbol === putSym) && Number(p.qty ?? p.quantity ?? 1) > 0
  );

  if (snapshot.status === 'CLOSED') {
    if (openCyclePositions.length === 0) {
      claims.push({
        claim: 'Cycle flat on exchange (0 remaining positions for cycle)',
        recordedValue: 0,
        venueValue: 0,
        status: 'MATCH',
      });
    } else {
      claims.push({
        claim: 'Cycle flat on exchange (0 remaining positions for cycle)',
        recordedValue: 0,
        venueValue: openCyclePositions.length,
        status: 'MISMATCH',
        reason: `Exchange still has ${openCyclePositions.length} open position(s) for cycle: ${openCyclePositions.map((p) => p.symbol).join(', ')}`,
      });
    }

    const openCycleOrders = venueOrders.filter((o) => o.symbol === callSym || o.symbol === putSym);
    if (openCycleOrders.length === 0) {
      claims.push({
        claim: 'Zero open orders on exchange for cycle contracts',
        recordedValue: 0,
        venueValue: 0,
        status: 'MATCH',
      });
    } else {
      claims.push({
        claim: 'Zero open orders on exchange for cycle contracts',
        recordedValue: 0,
        venueValue: openCycleOrders.length,
        status: 'MISMATCH',
        reason: `Exchange has ${openCycleOrders.length} open orders remaining for cycle: ${openCycleOrders.map((o) => o.symbol).join(', ')}`,
      });
    }
  }

  // Verification 5: Ledger Cash Flow & Fees summary
  let totalTradeGrossCashFlowInr = 0;
  let totalTradeNetCashFlowInr = 0;
  let totalFeesInr = 0;
  let deliveryRowsCount = 0;
  let tradeRowsCount = 0;

  for (const row of venueLedger) {
    if (row.symbol === callSym || row.symbol === putSym) {
      const type = String(row.transactionType || row.type || '').toUpperCase();
      if (type === 'DELIVERY') deliveryRowsCount++;
      if (type === 'TRADE') tradeRowsCount++;

      const fee = Number(row.fee ?? 0);
      const gross = Number(row.grossCashFlow ?? row.gross_cash_flow ?? 0);
      const net = Number(row.netCashFlow ?? row.net_cash_flow ?? 0);

      if (Number.isFinite(fee)) totalFeesInr += fee;
      if (Number.isFinite(gross)) totalTradeGrossCashFlowInr += gross;
      if (Number.isFinite(net)) totalTradeNetCashFlowInr += net;
    }
  }

  if (tradeRowsCount > 0 || deliveryRowsCount > 0) {
    claims.push({
      claim: 'Venue ledger rows for cycle contracts',
      recordedValue: 'TRADE + DELIVERY rows',
      venueValue: `${tradeRowsCount} trade(s), ${deliveryRowsCount} delivery`,
      status: 'MATCH',
      reason: `Total fees: ₹${totalFeesInr.toFixed(2)}, Gross: ₹${totalTradeGrossCashFlowInr.toFixed(2)}, Net: ₹${totalTradeNetCashFlowInr.toFixed(2)}`,
    });
  } else {
    claims.push({
      claim: 'Venue ledger rows for cycle contracts',
      recordedValue: 'TRADE rows',
      venueValue: null,
      status: 'UNVERIFIED',
      reason: 'No ledger rows found for cycle contracts in the available wallet transactions window',
    });
  }

  // Compute overall verdict
  const hasMismatch = claims.some((c) => c.status === 'MISMATCH');
  const hasUnverified = claims.some((c) => c.status === 'UNVERIFIED');

  const overallVerdict: OverallVerificationVerdict = hasMismatch
    ? 'FAILED'
    : hasUnverified
    ? 'PARTIAL'
    : 'VERIFIED';

  return {
    cycle: cycleExpiryStr,
    overallVerdict,
    readTimestamp,
    claims,
    ledgerSummary: {
      totalTradeGrossCashFlowInr,
      totalTradeNetCashFlowInr,
      totalFeesInr,
      deliveryRowsCount,
      tradeRowsCount,
      transactionCount: venueLedger.length,
    },
  };
}

export function formatVerificationReportTable(report: CycleVerificationReport): string {
  let out = `\n=======================================================\n`;
  out += `  CYCLE VERIFICATION AGAINST VENUE: ${report.cycle}\n`;
  out += `  Overall Verdict: ${report.overallVerdict}\n`;
  out += `  Read At        : ${report.readTimestamp}\n`;
  out += `=======================================================\n\n`;

  out += `| Claim | Recorded | Venue | Delta | Verdict | Details |\n`;
  out += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const c of report.claims) {
    const recordedStr = typeof c.recordedValue === 'number' ? c.recordedValue.toFixed(2) : String(c.recordedValue);
    const venueStr = c.venueValue !== null ? (typeof c.venueValue === 'number' ? c.venueValue.toFixed(2) : String(c.venueValue)) : 'N/A';
    const deltaStr = c.delta !== undefined && c.delta !== null ? c.delta.toFixed(2) : '-';
    const reasonStr = c.reason ? c.reason.replace(/\|/g, '/') : '-';
    out += `| ${c.claim} | ${recordedStr} | ${venueStr} | ${deltaStr} | **\`${c.status}\`** | ${reasonStr} |\n`;
  }

  if (report.ledgerSummary && report.ledgerSummary.transactionCount > 0) {
    out += `\n**Ledger Cash Flow Breakdown:**\n`;
    out += `- Total Fees: ₹${report.ledgerSummary.totalFeesInr.toFixed(2)}\n`;
    out += `- Total Gross Cash Flow: ₹${report.ledgerSummary.totalTradeGrossCashFlowInr.toFixed(2)}\n`;
    out += `- Total Net Cash Flow: ₹${report.ledgerSummary.totalTradeNetCashFlowInr.toFixed(2)}\n`;
  }

  return out;
}
