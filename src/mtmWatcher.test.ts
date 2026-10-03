import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  formatTimeString,
  getMtmLogFilePath,
  recordMtmLog,
} from './mtmWatcher';

describe('MTM Watcher Tests', () => {
  const testDate = '2099-12-31';
  const filePath = getMtmLogFilePath(testDate);

  const cleanFile = () => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  };

  it('formats time string into HH:MM:SS AM/PM correctly', () => {
    const d1 = new Date(2026, 9, 3, 8, 50, 0); // 08:50:00 AM
    assert.equal(formatTimeString(d1), '08:50:00 AM');

    const d2 = new Date(2026, 9, 3, 18, 15, 2); // 06:15:02 PM
    assert.equal(formatTimeString(d2), '06:15:02 PM');

    const d3 = new Date(2026, 9, 3, 0, 0, 0); // 12:00:00 AM
    assert.equal(formatTimeString(d3), '12:00:00 AM');

    const d4 = new Date(2026, 9, 3, 12, 0, 0); // 12:00:00 PM
    assert.equal(formatTimeString(d4), '12:00:00 PM');
  });

  it('appends MTM entries formatted as requested to daily file', async () => {
    cleanFile();

    const t1 = new Date(2026, 9, 3, 8, 50, 0);
    const t2 = new Date(2026, 9, 3, 8, 50, 2);

    await recordMtmLog(100, t1, testDate);
    await recordMtmLog(101, t2, testDate);

    assert.equal(fs.existsSync(filePath), true);

    const contents = await fs.promises.readFile(filePath, 'utf8');
    const lines = contents.trim().split('\n').map((l) => l.trim());

    assert.equal(lines.length, 2);
    assert.equal(lines[0], '08:50:00 AM: 100 MTM');
    assert.equal(lines[1], '08:50:02 AM: 101 MTM');

    cleanFile();
  });
});
