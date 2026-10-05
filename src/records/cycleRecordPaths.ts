import fs from 'fs';
import path from 'path';
import { assertSafeTestDirectory } from '../testIsolationGuard';

export function getRecordsDir(): string {
  const dir = process.env.RECORD_DIR
    ? path.resolve(process.env.RECORD_DIR)
    : path.resolve(process.cwd(), 'records');
  assertSafeTestDirectory(dir, 'records directory');
  return dir;
}

export function ensureRecordsDirectory(): string {
  const dir = getRecordsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getRecordJsonlPath(expiryDateStr: string): string {
  return path.join(getRecordsDir(), `${expiryDateStr}.jsonl`);
}

export function getRecordMtmPath(expiryDateStr: string): string {
  return path.join(getRecordsDir(), `${expiryDateStr}.mtm.jsonl`);
}

export function getRecordSummaryPath(expiryDateStr: string): string {
  return path.join(getRecordsDir(), `${expiryDateStr}.summary.json`);
}
