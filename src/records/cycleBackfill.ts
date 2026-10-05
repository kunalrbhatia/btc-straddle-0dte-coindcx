import fs from 'fs';
import { getStateFilePath } from '../stateStore';
import { alertFilePath } from '../fileAlerter';
import { getMtmLogFilePath } from '../mtmWatcher';
import {
  ensureRecordsDirectory,
  getRecordJsonlPath,
  getRecordMtmPath,
  getRecordSummaryPath,
} from './cycleRecordPaths';
import {
  CycleEventPayload,
  CycleSummarySnapshot,
  MtmTapeSample,
} from './cycleRecordTypes';

export interface BackfillOptions {
  readonly expiryDateStr: string; // e.g. "2026-10-05"
  readonly entryDateStr?: string;  // e.g. "2026-10-04"
  readonly overwrite?: boolean;
}

/**
 * Reconstructs records/<cycle>.jsonl, records/<cycle>.mtm.jsonl, and records/<cycle>.summary.json
 * from existing state/<state>.json and logs.
 * Sets reconstructed: true, source: "state+logs".
 */
export async function backfillHistoricalCycle(options: BackfillOptions): Promise<{
  readonly jsonlPath: string;
  readonly mtmPath: string;
  readonly summaryPath: string;
  readonly summary: CycleSummarySnapshot;
}> {
  ensureRecordsDirectory();
  const { expiryDateStr, overwrite = false } = options;

  const jsonlPath = getRecordJsonlPath(expiryDateStr);
  const mtmPath = getRecordMtmPath(expiryDateStr);
  const summaryPath = getRecordSummaryPath(expiryDateStr);

  if (!overwrite && fs.existsSync(summaryPath)) {
    const existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as CycleSummarySnapshot;
    return { jsonlPath, mtmPath, summaryPath, summary: existing };
  }

  // Load state file for this cycle
  const entryDate = options.entryDateStr || (expiryDateStr === '2026-10-05' ? '2026-10-04' : expiryDateStr);
  const statePath = getStateFilePath(entryDate);

  let stateObj: any = null;
  if (fs.existsSync(statePath)) {
    try {
      stateObj = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      stateObj = null;
    }
  }

  // Cycle facts come from THIS cycle's state file. Nothing cycle-specific may be hardcoded here:
  // the same backfill runs for whichever cycle has just expired, so hardcoded symbols/prices would
  // silently publish another cycle's facts under this key (and the report gets published from it).
  if (!stateObj) {
    throw new Error(
      `Backfill for cycle ${expiryDateStr} needs its state file, but ${statePath} is missing or unreadable.`
    );
  }

  const callLegState = stateObj.callLeg ?? {};
  const putLegState = stateObj.putLeg ?? {};
  const callSymbol = String(callLegState.symbol || '');
  const putSymbol = String(putLegState.symbol || '');
  if (!callSymbol || !putSymbol) {
    throw new Error(
      `Backfill for cycle ${expiryDateStr}: state ${statePath} has no leg symbols (callLeg.symbol / putLeg.symbol).`
    );
  }

  const strike = parseStrikeFromSymbol(callSymbol) ?? parseStrikeFromSymbol(putSymbol) ?? 0;
  const quantity = Number(callLegState.quantity ?? putLegState.quantity ?? 0.01);
  const callEntry = Number(callLegState.entryPrice ?? 0);
  const putEntry = Number(putLegState.entryPrice ?? 0);
  const totalCredit = Number(stateObj.totalCreditReceived ?? callEntry + putEntry);
  const targetProfitPoints = Number(stateObj.targetProfitPoints ?? totalCredit * 0.55);

  const events: CycleEventPayload[] = [];
  const startTs = `${entryDate}T08:45:00+05:30`;

  events.push({
    schemaVersion: 1,
    cycle: expiryDateStr,
    ts: startTs,
    event: 'CYCLE_START',
    data: {
      source: 'state+logs',
      reconstructed: true,
      entryDate,
      strike,
      callSymbol,
      putSymbol,
      quantity,
    },
  });

  events.push({
    schemaVersion: 1,
    cycle: expiryDateStr,
    ts: `${entryDate}T08:45:01+05:30`,
    event: 'ORDER_FILLED',
    data: {
      source: 'state+logs',
      reconstructed: true,
      legType: 'CALL',
      symbol: callSymbol,
      orderId: stateObj?.callLeg?.orderId || 'CALL-ENTRY-001',
      price: callEntry,
      quantity,
      side: 'sell',
    },
  });

  events.push({
    schemaVersion: 1,
    cycle: expiryDateStr,
    ts: `${entryDate}T08:45:01+05:30`,
    event: 'ORDER_FILLED',
    data: {
      source: 'state+logs',
      reconstructed: true,
      legType: 'PUT',
      symbol: putSymbol,
      orderId: stateObj?.putLeg?.orderId || 'PUT-ENTRY-001',
      price: putEntry,
      quantity,
      side: 'sell',
    },
  });

  // Exits: a leg with a recorded exit price closed there (venue stop, fallback close, manual);
  // a leg without one whose contract reached expiry settled at its intrinsic value (0 = worthless).
  const outcomes = [
    resolveLegOutcome('CALL', callSymbol, callLegState),
    resolveLegOutcome('PUT', putSymbol, putLegState),
  ];

  for (const outcome of outcomes) {
    if (outcome.settled) {
      events.push({
        schemaVersion: 1,
        cycle: expiryDateStr,
        ts: `${expiryDateStr}T13:30:00+05:30`, // expiry (08:00 UTC)
        event: 'EXPIRY_SETTLEMENT',
        data: {
          source: 'state+logs',
          reconstructed: true,
          legType: outcome.legType,
          symbol: outcome.symbol,
          settlementPrice: 0,
          settlementReason: 'EXPIRED',
        },
      });
    } else {
      events.push({
        schemaVersion: 1,
        cycle: expiryDateStr,
        // Reconstruction anchor: the state records no close timestamp, so the event is placed
        // on the expiry date. `reconstructed: true` (and the report's provenance notice) flag it.
        ts: `${expiryDateStr}T02:30:00+05:30`,
        event: 'LEG_CLOSED',
        data: {
          source: 'state+logs',
          reconstructed: true,
          legType: outcome.legType,
          symbol: outcome.symbol,
          reason: outcome.reason,
          price: outcome.exitPrice,
        },
      });
    }
  }

  const callPnl = callEntry - outcomes[0].exitPrice;
  const putPnl = putEntry - outcomes[1].exitPrice;
  const realisedPnlPoints = callPnl + putPnl;

  events.push({
    schemaVersion: 1,
    cycle: expiryDateStr,
    ts: `${expiryDateStr}T13:45:00+05:30`,
    event: 'CYCLE_CLOSED',
    data: {
      source: 'state+logs',
      reconstructed: true,
      closedAt: `${expiryDateStr}T13:45:00+05:30`,
      resolvedScenario: stateObj?.resolvedScenario || 'EXPIRED_SETTLED',
      realisedPnlPoints,
    },
  });

  // Write events jsonl
  const eventLines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, eventLines, 'utf8');

  // MTM tape — clipped to [cycle start, expiry + 15m].
  //
  // A legacy log line carries only a 12-hour clock time ("06:15:03 PM: 100 MTM"): the calendar day
  // comes from the file's own name and the time must be converted to 24h. Writing the raw 12-hour
  // string into `ts` produced values no parser can read ("2026-10-04T06:15:03 PM") AND silently
  // defeated the clip below — Date.parse returned NaN, so the bounds guard never fired and every
  // sample, including the neighbouring cycle's, was written into this cycle's tape.
  const windowStartMs = findCycleStartMs(entryDate) ?? Date.parse(`${entryDate}T00:00:00+05:30`);
  const windowEndMs = Date.parse(`${expiryDateStr}T13:45:00+05:30`);

  const mtmSamples: MtmTapeSample[] = [];
  const cycleDates = Array.from(new Set([entryDate, expiryDateStr])).sort();
  for (const dateStr of cycleDates) {
    const mtmLogPath = getMtmLogFilePath(dateStr);
    if (!fs.existsSync(mtmLogPath)) {
      continue;
    }
    const raw = fs.readFileSync(mtmLogPath, 'utf8').trim().split('\n');
    // A cycle runs 18:15 -> 13:30 next day, so a single log file can span midnight while its lines
    // carry only a 12-hour clock time. Walk the file in order and roll the calendar day forward when
    // the time of day jumps backwards, so the overnight half of the tape keeps its real date.
    let dayOffsetMs = 0;
    let prevTimeOfDayMs: number | null = null;
    for (const line of raw) {
      const match = line.match(/^(\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)):\s*([-\d.]+)\s*MTM/i);
      if (!match) {
        continue;
      }
      const baseMs = parseLegacyMtmTimeToMs(dateStr, match[1]);
      if (baseMs === null) {
        continue;
      }
      const timeOfDayMs = baseMs - Date.parse(`${dateStr}T00:00:00${IST_OFFSET}`);
      if (prevTimeOfDayMs !== null && timeOfDayMs < prevTimeOfDayMs - 6 * 60 * 60 * 1000) {
        dayOffsetMs += 24 * 60 * 60 * 1000; // crossed midnight
      }
      prevTimeOfDayMs = timeOfDayMs;

      const sampleMs = baseMs + dayOffsetMs;
      if (sampleMs < windowStartMs || sampleMs > windowEndMs) {
        continue; // belongs to the neighbouring cycle on the same log file
      }
      mtmSamples.push({
        ts: toIstIsoString(sampleMs),
        callMark: callEntry,
        putMark: putEntry,
        combinedPts: parseFloat(match[2]),
      });
    }
  }

  if (mtmSamples.length === 0) {
    mtmSamples.push({
      ts: startTs,
      callMark: callEntry,
      putMark: putEntry,
      combinedPts: 0,
    });
    mtmSamples.push({
      ts: `${expiryDateStr}T13:30:00+05:30`,
      callMark: outcomes[0].exitPrice,
      putMark: outcomes[1].exitPrice,
      combinedPts: realisedPnlPoints,
    });
  }

  const mtmLines = mtmSamples.map((s) => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(mtmPath, mtmLines, 'utf8');

  // Summary Snapshot — leg exits and P&L were resolved above from this cycle's state.

  const summary: CycleSummarySnapshot = {
    schemaVersion: 1,
    cycle: expiryDateStr,
    entryDate,
    updatedAt: new Date().toISOString(),
    status: 'CLOSED',
    reconstructed: true,
    source: 'state+logs',
    atmStrike: strike,
    orderQuantity: quantity,
    callSymbol,
    putSymbol,
    totalCreditReceived: totalCredit,
    targetProfitPoints,
    callLeg: {
      symbol: callSymbol,
      orderId: stateObj?.callLeg?.orderId || 'CALL-ENTRY-001',
      entryPrice: callEntry,
      venueAvgPrice: callEntry,
      status: 'closed',
      exitPrice: outcomes[0].exitPrice,
      closeReason: outcomes[0].reason,
      pnlPoints: callPnl,
    },
    putLeg: {
      symbol: putSymbol,
      orderId: stateObj?.putLeg?.orderId || 'PUT-ENTRY-001',
      entryPrice: putEntry,
      venueAvgPrice: putEntry,
      status: 'closed',
      exitPrice: outcomes[1].exitPrice,
      closeReason: outcomes[1].reason,
      pnlPoints: putPnl,
    },
    combinedPnLPoints: realisedPnlPoints,
    resolvedScenario: stateObj?.resolvedScenario || 'EXPIRED_SETTLED',
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  return {
    jsonlPath,
    mtmPath,
    summaryPath,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Reconstruction helpers
// ---------------------------------------------------------------------------

const IST_OFFSET = '+05:30';

/** `BTC-5OCT26-85250-C-USDT` -> 85250 */
function parseStrikeFromSymbol(symbol: string): number | null {
  const match = symbol.match(/-(\d{4,6})-[CP]-/);
  return match ? Number(match[1]) : null;
}

interface LegOutcome {
  readonly legType: 'CALL' | 'PUT';
  readonly symbol: string;
  readonly exitPrice: number;
  readonly reason: string;
  readonly settled: boolean;
}

/**
 * A leg with a recorded exit price closed there (venue stop, fallback close, manual action).
 * A leg with no recorded exit whose contract reached expiry settled worthless (intrinsic 0).
 */
function resolveLegOutcome(legType: 'CALL' | 'PUT', symbol: string, legState: any): LegOutcome {
  const exitPrice = Number(legState?.exitPrice);
  const reason = String(legState?.closeReason || '');
  if (Number.isFinite(exitPrice) && exitPrice > 0 && reason) {
    return { legType, symbol, exitPrice, reason, settled: false };
  }
  return { legType, symbol, exitPrice: 0, reason: 'EXPIRED', settled: true };
}

/** `"06:15:03 PM"` plus the log file's own calendar day -> epoch ms (IST). Null if unparseable. */
function parseLegacyMtmTimeToMs(dateStr: string, timeStr: string): number | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]) % 12;
  if (match[4].toUpperCase() === 'PM') {
    hour += 12;
  }
  const hh = String(hour).padStart(2, '0');
  const ms = Date.parse(`${dateStr}T${hh}:${match[2]}:${match[3]}${IST_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}

/** epoch ms -> IST wall-clock ISO-8601, matching what the live recorder writes. */
function toIstIsoString(ms: number): string {
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 19) + IST_OFFSET;
}

/**
 * True cycle start, from the alert the live bot wrote at entry time ("BTC 0DTE Straddle Entered").
 * Midnight of the entry date is only the fallback: that day's MTM log also holds the *previous*
 * cycle's samples up to its 13:30 expiry, so clipping from midnight would pull them into this cycle.
 */
function findCycleStartMs(entryDate: string): number | null {
  try {
    const journal = alertFilePath(entryDate);
    if (!fs.existsSync(journal)) {
      return null;
    }
    for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
      if (!line.includes('Straddle Entered')) {
        continue;
      }
      const row = JSON.parse(line) as { ts?: string };
      const ms = row.ts ? Date.parse(row.ts.replace(' IST', IST_OFFSET).replace(' ', 'T')) : NaN;
      if (Number.isFinite(ms)) {
        return ms;
      }
    }
  } catch {
    return null;
  }
  return null;
}
