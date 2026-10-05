import fs from 'fs';
import path from 'path';
import { assertSafeTestDirectory } from '../testIsolationGuard';

// Overridable (BTC_REPORTS_DIR) so tests do not touch live repo reports directory
export function getReportsDir(): string {
  const dir = process.env.BTC_REPORTS_DIR
    ? path.resolve(process.env.BTC_REPORTS_DIR)
    : path.resolve(process.cwd(), 'reports');
  assertSafeTestDirectory(dir, 'reports directory');
  return dir;
}

export function ensureReportsDirectory(): string {
  const dir = getReportsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getReportFilePath(expiryDateStr: string): string {
  return path.join(getReportsDir(), `${expiryDateStr}.md`);
}
