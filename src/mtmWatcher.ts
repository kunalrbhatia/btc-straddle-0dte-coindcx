import fs from 'fs';
import path from 'path';
import { getTodayDateStringIST } from './stateStore';

// Overridable (BTC_LOGS_DIR) so test runs cannot append fake MTM lines into the
// live logs directory that the Hermes watch banner reads.
const LOGS_DIR = process.env.BTC_LOGS_DIR
  ? path.resolve(process.env.BTC_LOGS_DIR)
  : path.resolve(process.cwd(), 'logs');

export function ensureLogsDirectory(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function getMtmLogFilePath(dateStr = getTodayDateStringIST()): string {
  return path.join(LOGS_DIR, `mtm-${dateStr}.log`);
}

/**
 * Formats a Date into standard 12-hour AM/PM time with zero-padded seconds:
 * e.g. "08:50:00 AM" or "06:15:02 PM"
 */
export function formatTimeString(date = new Date()): string {
  // Respect local/IST time presentation
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';

  hours = hours % 12;
  hours = hours ? hours : 12; // 0 hour should be 12
  const formattedHours = String(hours).padStart(2, '0');

  return `${formattedHours}:${minutes}:${seconds} ${ampm}`;
}

/**
 * Records an MTM log line appended to logs/mtm-<YYYY-MM-DD>.log
 * Format:
 * 08:50:00 AM: 100 MTM
 * or with details if needed
 */
export async function recordMtmLog(
  mtmValue: number,
  now = new Date(),
  dateStr = getTodayDateStringIST(now)
): Promise<void> {
  ensureLogsDirectory();
  const filePath = getMtmLogFilePath(dateStr);
  const timeStr = formatTimeString(now);
  const formattedMtm = Number.isInteger(mtmValue)
    ? String(mtmValue)
    : mtmValue.toFixed(2);

  const line = `${timeStr}: ${formattedMtm} MTM\n`;

  await fs.promises.appendFile(filePath, line, 'utf8');
}
