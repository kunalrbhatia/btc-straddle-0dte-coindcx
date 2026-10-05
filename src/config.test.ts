import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequiredIntInRange, parseOptionalIntInRange } from './config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeCronRestart } = require('../ecosystem.config.js');

describe('Configuration & Scheduling Tests', () => {
  it('throws when EXECUTION_HOUR_IST is missing', () => {
    delete process.env.TEST_EXEC_HOUR;
    assert.throws(
      () => parseRequiredIntInRange('TEST_EXEC_HOUR', 0, 23),
      /Environment variable TEST_EXEC_HOUR is required but missing/
    );
  });

  it('throws when EXECUTION_HOUR_IST is out of range', () => {
    process.env.TEST_EXEC_HOUR = '24';
    assert.throws(
      () => parseRequiredIntInRange('TEST_EXEC_HOUR', 0, 23),
      /Environment variable TEST_EXEC_HOUR must be an integer between 0 and 23/
    );

    process.env.TEST_EXEC_HOUR = '-1';
    assert.throws(
      () => parseRequiredIntInRange('TEST_EXEC_HOUR', 0, 23),
      /Environment variable TEST_EXEC_HOUR must be an integer between 0 and 23/
    );

    process.env.TEST_EXEC_HOUR = 'abc';
    assert.throws(
      () => parseRequiredIntInRange('TEST_EXEC_HOUR', 0, 23),
      /Environment variable TEST_EXEC_HOUR must be an integer between 0 and 23/
    );
    delete process.env.TEST_EXEC_HOUR;
  });

  it('throws when EXECUTION_MINUTE_IST is out of range', () => {
    process.env.TEST_EXEC_MIN = '60';
    assert.throws(
      () => parseRequiredIntInRange('TEST_EXEC_MIN', 0, 59),
      /Environment variable TEST_EXEC_MIN must be an integer between 0 and 59/
    );
    delete process.env.TEST_EXEC_MIN;
  });

  it('parses valid execution hour and minute', () => {
    process.env.TEST_EXEC_HOUR = '18';
    process.env.TEST_EXEC_MIN = '15';
    assert.equal(parseRequiredIntInRange('TEST_EXEC_HOUR', 0, 23), 18);
    assert.equal(parseRequiredIntInRange('TEST_EXEC_MIN', 0, 59), 15);
    delete process.env.TEST_EXEC_HOUR;
    delete process.env.TEST_EXEC_MIN;
  });

  it('handles optional int with default and range validation', () => {
    delete process.env.TEST_EXPIRY_HOUR;
    assert.equal(parseOptionalIntInRange('TEST_EXPIRY_HOUR', 8, 0, 23), 8);

    process.env.TEST_EXPIRY_HOUR = '12';
    assert.equal(parseOptionalIntInRange('TEST_EXPIRY_HOUR', 8, 0, 23), 12);

    process.env.TEST_EXPIRY_HOUR = '25';
    assert.throws(
      () => parseOptionalIntInRange('TEST_EXPIRY_HOUR', 8, 0, 23),
      /Environment variable TEST_EXPIRY_HOUR must be an integer between 0 and 23/
    );
    delete process.env.TEST_EXPIRY_HOUR;
  });

  it('computes correct PM2 cron_restart string with 45m lead and midnight wrap', () => {
    // 18:15 IST - 45 min -> 17:30 IST
    assert.equal(computeCronRestart('18', '15', '45'), '30 17 * * *');

    // 20:00 IST - 45 min -> 19:15 IST
    assert.equal(computeCronRestart('20', '00', '45'), '15 19 * * *');

    // Midnight wrap: 00:20 IST - 45 min -> 23:35 IST previous day
    assert.equal(computeCronRestart('0', '20', '45'), '35 23 * * *');

    // Exact midnight: 00:00 IST - 45 min -> 23:15 IST
    assert.equal(computeCronRestart('0', '0', '45'), '15 23 * * *');
  });
});
