import fs from 'fs';
import path from 'path';
import { getStateDir, loadStraddleState } from '../stateStore';
import { StraddlePositionState } from '../types';

export interface AlertLogItem {
  readonly ts: string;
  readonly kind: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

export interface MtmStats {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

export function parseContractExpiryDate(symbol: string): string | null {
  // Format: BTC-<D><MMM><YY>-<strike>-<type>-USDT or BTC-<DD><MMM><YY>-<strike>-<type>-USDT
  // e.g. BTC-5OCT26-85500-C-USDT -> 2026-10-05
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

  const fullYear = `20${yearShort}`;
  return `${fullYear}-${month}-${day}`;
}

export async function findStateForExpiry(targetExpiryDateStr: string): Promise<{
  state: StraddlePositionState;
  entryDate: string;
  expiryDate: string;
  expirySource: 'symbol_parsed' | 'date_inferred';
} | null> {
  const stateDir = getStateDir();
  if (!fs.existsSync(stateDir)) {
    return null;
  }

  const files = (await fs.promises.readdir(stateDir))
    .filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'))
    .sort()
    .reverse();

  for (const f of files) {
    const dateMatch = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
    if (!dateMatch) continue;
    const entryDate = dateMatch[1];
    const state = await loadStraddleState(entryDate);
    if (!state) continue;

    // Check symbols first
    const callExpiry = parseContractExpiryDate(state.callLeg?.symbol || '');
    const putExpiry = parseContractExpiryDate(state.putLeg?.symbol || '');
    const matchedExpiry = callExpiry || putExpiry;

    if (matchedExpiry === targetExpiryDateStr) {
      return {
        state,
        entryDate,
        expiryDate: targetExpiryDateStr,
        expirySource: 'symbol_parsed',
      };
    }

    // If entry date matches targetExpiryDateStr directly and symbol parse failed
    if (entryDate === targetExpiryDateStr && !matchedExpiry) {
      return {
        state,
        entryDate,
        expiryDate: targetExpiryDateStr,
        expirySource: 'date_inferred',
      };
    }
  }

  return null;
}

export function parseMtmLogs(dateStrings: string[]): MtmStats {
  const logsDir = process.env.BTC_LOGS_DIR
    ? path.resolve(process.env.BTC_LOGS_DIR)
    : path.resolve(process.cwd(), 'logs');

  let count = 0;
  let min: number | null = null;
  let max: number | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const dateStr of dateStrings) {
    const filePath = path.join(logsDir, `mtm-${dateStr}.log`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Line format: "12:15:21 PM: 100 MTM" or "12:15:21 PM: -50.25 MTM"
        const m = trimmed.match(/^(\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)):\s*(-?[\d.]+)\s*MTM/i);
        if (m) {
          const time = `${dateStr} ${m[1]}`;
          const val = parseFloat(m[2]);
          if (Number.isFinite(val)) {
            count++;
            if (first === null) {
              first = val;
              firstTimestamp = time;
            }
            last = val;
            lastTimestamp = time;

            if (min === null || val < min) min = val;
            if (max === null || val > max) max = val;
          }
        }
      }
    } catch {
      // Ignore unreadable log
    }
  }

  return { count, min, max, first, last, firstTimestamp, lastTimestamp };
}

export function readCombinedAlerts(dateStrings: string[]): AlertLogItem[] {
  const alertsDir = process.env.BTC_ALERTS_DIR
    ? path.resolve(process.env.BTC_ALERTS_DIR)
    : path.resolve(process.cwd(), 'logs');

  const alerts: AlertLogItem[] = [];

  for (const dateStr of dateStrings) {
    const filePath = path.join(alertsDir, `alerts-${dateStr}.jsonl`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as AlertLogItem;
          if (parsed && typeof parsed.ts === 'string') {
            alerts.push(parsed);
          }
        } catch {
          // Ignore corrupted line
        }
      }
    } catch {
      // Ignore unreadable file
    }
  }

  // Sort by ts
  alerts.sort((a, b) => a.ts.localeCompare(b.ts));
  return alerts;
}

/**
 * Parses alert ts string (e.g. "2026-10-05 10:52:46 IST" or ISO string) to epoch ms.
 */
export function parseAlertTimestampMs(ts: string): number | null {
  if (!ts || typeof ts !== 'string') return null;
  const normalized = ts.includes(' IST')
    ? ts.replace(' IST', ' +05:30')
    : ts;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export interface AlertFilterOptions {
  readonly windowStartMs?: number;
  readonly windowEndMs?: number;
  readonly allowedSymbols?: readonly string[];
}

export interface CollapsedAlertItem {
  readonly kind: string;
  readonly message: string;
  readonly count: number;
  readonly firstTs: string;
  readonly lastTs: string;
  readonly firstTimeOnly: string;
  readonly lastTimeOnly: string;
}

function extractTimePart(ts: string): string {
  // e.g. "2026-10-05 10:52:46 IST" -> "10:52:46"
  const m = ts.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return m ? m[1] : ts;
}

/**
 * Filters alerts to a cycle window and eliminates mentions of foreign cycle contracts,
 * then collapses consecutive runs of identical (kind, message) events.
 */
export function filterAndCollapseAlerts(
  alerts: readonly AlertLogItem[],
  options: AlertFilterOptions = {}
): CollapsedAlertItem[] {
  const { windowStartMs, windowEndMs, allowedSymbols } = options;
  const allowedSet = allowedSymbols && allowedSymbols.length > 0 ? new Set(allowedSymbols) : null;

  // 1. Filter
  const filtered = alerts.filter((item) => {
    // Window filtering
    if (windowStartMs !== undefined || windowEndMs !== undefined) {
      const tsMs = parseAlertTimestampMs(item.ts);
      if (tsMs !== null) {
        if (windowStartMs !== undefined && tsMs < windowStartMs) return false;
        if (windowEndMs !== undefined && tsMs > windowEndMs) return false;
      }
    }

    // Symbol isolation: if allowedSymbols provided, reject any alert mentioning foreign contracts
    if (allowedSet) {
      const content = `${item.message} ${JSON.stringify(item.meta ?? {})}`;
      const symbolMatches = content.match(/BTC-\d{1,2}[A-Z]{3}\d{2}-\d+-[CP]-USDT/gi);
      if (symbolMatches && symbolMatches.length > 0) {
        // Must contain ONLY allowed symbols
        const hasForeignSymbol = symbolMatches.some((s) => !allowedSet.has(s.toUpperCase()));
        if (hasForeignSymbol) {
          return false;
        }
      }
    }

    return true;
  });

  // 2. Collapse consecutive identical (kind, message) runs
  const collapsed: CollapsedAlertItem[] = [];

  for (const item of filtered) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.kind === item.kind && prev.message === item.message) {
      // Extend consecutive run
      collapsed[collapsed.length - 1] = {
        kind: prev.kind,
        message: prev.message,
        count: prev.count + 1,
        firstTs: prev.firstTs,
        lastTs: item.ts,
        firstTimeOnly: prev.firstTimeOnly,
        lastTimeOnly: extractTimePart(item.ts),
      };
    } else {
      collapsed.push({
        kind: item.kind,
        message: item.message,
        count: 1,
        firstTs: item.ts,
        lastTs: item.ts,
        firstTimeOnly: extractTimePart(item.ts),
        lastTimeOnly: extractTimePart(item.ts),
      });
    }
  }

  return collapsed;
}

