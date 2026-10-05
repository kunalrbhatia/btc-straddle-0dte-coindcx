import fs from 'fs';
import path from 'path';
import { StraddlePositionState } from './types';

import { assertSafeTestDirectory } from './testIsolationGuard';

// Overridable (BTC_STATE_DIR) so test runs cannot write a fake position into
// the live state directory that the bot reconciles against at startup.
export function getStateDir(): string {
  const dir = process.env.BTC_STATE_DIR
    ? path.resolve(process.env.BTC_STATE_DIR)
    : path.resolve(process.cwd(), 'state');
  assertSafeTestDirectory(dir, 'state directory');
  return dir;
}

export function getTodayDateStringIST(now = new Date()): string {
  // IST is UTC + 5:30 (330 minutes)
  const istOffsetMs = 330 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getStateFilePath(dateStr: string): string {
  return path.join(getStateDir(), `straddle-state-${dateStr}.json`);
}

export function ensureStateDirectory(): void {
  const dir = getStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Searches for all straddle state files and returns the most recent one by date filename.
 */
export async function findLatestStraddleState(): Promise<{ state: StraddlePositionState; date: string } | null> {
  const dir = getStateDir();
  if (!fs.existsSync(dir)) {
    return null;
  }

  try {
    const files = await fs.promises.readdir(dir);
    const stateFiles = files
      .filter((f) => f.startsWith('straddle-state-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const f of stateFiles) {
      const dateMatch = f.match(/straddle-state-(\d{4}-\d{2}-\d{2})\.json/);
      const dateStr = dateMatch ? dateMatch[1] : '';
      const state = await loadStraddleState(dateStr);
      if (state && state.entryExecuted) {
        return { state, date: dateStr };
      }
    }
  } catch (err) {
    console.error(`[StateStore] Error scanning state directory: ${err}`);
  }

  return null;
}

export async function saveStraddleState(
  state: StraddlePositionState,
  dateStr = getTodayDateStringIST()
): Promise<void> {
  ensureStateDirectory();
  const targetPath = getStateFilePath(dateStr);
  const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.tmp`;

  const payload = JSON.stringify(state, null, 2);

  await fs.promises.writeFile(tempPath, payload, 'utf8');

  // Atomic rename with retries for Windows file lock tolerance
  let renamed = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rename(tempPath, targetPath);
      renamed = true;
      break;
    } catch (err: any) {
      lastErr = err;
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      } else {
        break;
      }
    }
  }

  if (!renamed) {
    try {
      // Fallback direct write on persistent Windows file lock
      await fs.promises.writeFile(targetPath, payload, 'utf8');
      await fs.promises.unlink(tempPath).catch(() => {});
    } catch {
      throw lastErr;
    }
  }
}

/**
 * Loads today's persisted straddle state, if it exists
 */
export async function loadStraddleState(
  dateStr = getTodayDateStringIST()
): Promise<StraddlePositionState | null> {
  const filePath = getStateFilePath(dateStr);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as StraddlePositionState;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[StateStore] Failed to parse state file ${filePath}: ${msg}`);
    return null;
  }
}

/**
 * Checks if today's entry has already been executed (idempotency guard)
 */
export async function hasTodayExecuted(dateStr = getTodayDateStringIST()): Promise<boolean> {
  const state = await loadStraddleState(dateStr);
  return Boolean(state && state.entryExecuted);
}

/**
 * True when the state still tracks a live leg that the bot has not resolved yet.
 *
 * Used as the "do not open a second straddle" guard before the daily entry. A
 * restart that lands mid-cycle resumes monitoring an open position; without this
 * guard the scheduler either enters again (double exposure) or — as happened on
 * 2026-10-05 — never arms at all and silently loses the day's trade.
 */
export function hasUnresolvedOpenLeg(state: StraddlePositionState | null | undefined): boolean {
  if (!state || !state.entryExecuted || state.resolvedScenario) {
    return false;
  }
  return state.callLeg.status === 'open' || state.putLeg.status === 'open';
}
