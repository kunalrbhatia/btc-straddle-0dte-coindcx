import fs from 'fs';
import path from 'path';

export function getRecordsDir(): string {
  return process.env.RECORD_DIR
    ? path.resolve(process.env.RECORD_DIR)
    : path.resolve(process.cwd(), 'records');
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
