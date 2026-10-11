import fs from 'fs';
import path from 'path';
import { OneDtePositionState } from './types';
import { assertSafeTestDirectory } from '../testIsolationGuard';

export function getOneDteStateDir(): string {
  const dir = process.env.ONEDTE_STATE_DIR
    ? path.resolve(process.env.ONEDTE_STATE_DIR)
    : path.resolve(process.cwd(), 'state');
  assertSafeTestDirectory(dir, '1dte state directory');
  return dir;
}

export function getOneDteStateFilePath(dateStr: string): string {
  return path.join(getOneDteStateDir(), `onedte-state-${dateStr}.json`);
}

export function ensureOneDteStateDirectory(): void {
  const dir = getOneDteStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function saveOneDteState(state: OneDtePositionState, dateStr: string): Promise<void> {
  ensureOneDteStateDirectory();
  const filePath = getOneDteStateFilePath(dateStr);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);

  await fs.promises.writeFile(tempPath, payload, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

export async function loadOneDteState(dateStr: string): Promise<OneDtePositionState | null> {
  const filePath = getOneDteStateFilePath(dateStr);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as OneDtePositionState;
  } catch (err) {
    console.error(`[1DTE State] Failed to read state from ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

export async function findLatestOneDteState(): Promise<{ state: OneDtePositionState; date: string } | null> {
  const dir = getOneDteStateDir();
  if (!fs.existsSync(dir)) {
    return null;
  }
  try {
    const files = await fs.promises.readdir(dir);
    const stateFiles = files
      .filter((f) => f.startsWith('onedte-state-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const f of stateFiles) {
      const match = f.match(/onedte-state-(\d{4}-\d{2}-\d{2})\.json/);
      if (match) {
        const state = await loadOneDteState(match[1]);
        if (state && state.entryExecuted) {
          return { state, date: match[1] };
        }
      }
    }
  } catch {
    // Ignore
  }
  return null;
}
