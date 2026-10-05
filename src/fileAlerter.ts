import fs from 'fs';
import path from 'path';

/**
 * Local alert journal.
 *
 * Why this exists: the bot's own Telegram notifier needs TELEGRAM_BOT_TOKEN in
 * .env, which is not configured, so failures were only visible in pm2 logs.
 * Every alert is therefore ALSO appended to a local JSONL journal that the
 * Hermes watch banner (`~/.hermes/scripts/btc-banner.py`) reads and forwards to
 * Telegram. No credentials required, and no polling conflict with other bots.
 *
 * File: logs/alerts-<YYYY-MM-DD>.jsonl  (one JSON object per line)
 */

import { assertSafeTestDirectory } from './testIsolationGuard';

// Overridable so test runs can never write into the live logs/ journal
// (the Hermes watch banner reads that directory and would forward test noise).
export function getAlertsDir(): string {
  const dir = process.env.BTC_ALERTS_DIR
    ? path.resolve(process.env.BTC_ALERTS_DIR)
    : path.resolve(process.cwd(), 'logs');
  assertSafeTestDirectory(dir, 'alerts log directory');
  return dir;
}

const IST_OFFSET_MINUTES = 330;

export interface AlertRecord {
  readonly ts: string;
  readonly kind: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * Optional alert collapsing.
 *
 * Why: a per-poll failure (e.g. the price feed going away for an option that has
 * already expired) used to journal one line EVERY poll — 2/second for hours — which
 * the Hermes watch banner relays verbatim. That is not news, and it buries the
 * alerts that are. With a `dedupKey`, the first occurrence is always written; exact
 * repeats inside `windowMs` are counted and dropped; the next emission after the
 * window carries the suppressed count so nothing is silently lost.
 *
 * Calls without `dedupKey` are unchanged (every alert still written).
 */
export interface AlertDedupOptions {
  readonly dedupKey?: string;
  /** Suppression window in ms. Defaults to 15 minutes. */
  readonly windowMs?: number;
}

const DEFAULT_DEDUP_WINDOW_MS = 15 * 60 * 1000;

interface DedupWindow {
  lastEmittedAt: number;
  suppressed: number;
  windowMs: number;
}

const dedupWindows = new Map<string, DedupWindow>();

/** Test/reset hook — clears all suppression state. */
export function resetAlertDedup(): void {
  dedupWindows.clear();
}

/**
 * Evaluates the dedup window for a key.
 * Returns whether this occurrence must be suppressed, and any note to append to
 * the message being written now (the suppressed-repetition count).
 */
function evaluateDedup(options?: AlertDedupOptions): { suppressed: boolean; note: string } {
  const key = options?.dedupKey;
  if (!key) {
    return { suppressed: false, note: '' };
  }

  const windowMs =
    options?.windowMs !== undefined && options.windowMs > 0
      ? options.windowMs
      : DEFAULT_DEDUP_WINDOW_MS;
  const now = Date.now();
  const entry = dedupWindows.get(key);

  if (!entry || now - entry.lastEmittedAt >= windowMs) {
    const repeats = entry ? entry.suppressed : 0;
    const note =
      repeats > 0
        ? ` [${repeats} repeat(s) suppressed in the previous ${Math.round(windowMs / 60000)} min]`
        : '';
    dedupWindows.set(key, { lastEmittedAt: now, suppressed: 0, windowMs });
    return { suppressed: false, note };
  }

  entry.suppressed += 1;
  return { suppressed: true, note: '' };
}

/** IST calendar date (YYYY-MM-DD) — the bot schedules everything in IST. */
export function getIstDateString(now = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Human-readable IST timestamp for the journal line. */
function getIstTimestamp(now = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const datePart = getIstDateString(now);
  const timePart = [
    ist.getUTCHours(),
    ist.getUTCMinutes(),
    ist.getUTCSeconds(),
  ]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
  return `${datePart} ${timePart} IST`;
}

export function alertFilePath(dateStr = getIstDateString()): string {
  return path.join(getAlertsDir(), `alerts-${dateStr}.jsonl`);
}

/**
 * Appends one alert to the journal. Never throws: an alerting failure must
 * never break trading.
 */
export function appendAlert(
  kind: string,
  message: string,
  meta?: Record<string, unknown>,
  options?: AlertDedupOptions
): void {
  try {
    const { suppressed, note } = evaluateDedup(options);
    if (suppressed) {
      return;
    }

    const dir = getAlertsDir();
    fs.mkdirSync(dir, { recursive: true });
    const record: AlertRecord = {
      ts: getIstTimestamp(),
      kind,
      message: `${message}${note}`,
      ...(meta ? { meta } : {}),
    };
    fs.appendFileSync(alertFilePath(), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[AlertJournal] Failed to write alert (${kind}): ${msg}`);
  }
}
