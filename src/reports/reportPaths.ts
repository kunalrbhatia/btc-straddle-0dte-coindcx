import fs from 'fs';
import path from 'path';

// Overridable (BTC_REPORTS_DIR) so tests do not touch live repo reports directory
export function getReportsDir(): string {
  return process.env.BTC_REPORTS_DIR
    ? path.resolve(process.env.BTC_REPORTS_DIR)
    : path.resolve(process.cwd(), 'reports');
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
