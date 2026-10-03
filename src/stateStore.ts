import fs from 'fs';
import path from 'path';
import { StraddlePositionState } from './types';

const STATE_DIR = path.resolve(process.cwd(), 'state');

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
  return path.join(STATE_DIR, `straddle-state-${dateStr}.json`);
}

export function ensureStateDirectory(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * Saves straddle state atomically (write to temp file then rename)
 */
export async function saveStraddleState(
  state: StraddlePositionState,
  dateStr = getTodayDateStringIST()
): Promise<void> {
  ensureStateDirectory();
  const targetPath = getStateFilePath(dateStr);
  const tempPath = `${targetPath}.${Date.now()}.tmp`;

  const payload = JSON.stringify(state, null, 2);

  await fs.promises.writeFile(tempPath, payload, 'utf8');
  await fs.promises.rename(tempPath, targetPath);
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
