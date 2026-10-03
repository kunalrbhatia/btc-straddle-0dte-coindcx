import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { acquireInstanceLock, isProcessRunning } from './instanceLock';

describe('InstanceLock Unit Tests', () => {
  const testDir = path.join(os.tmpdir(), 'btc-test-lock-unit');

  it('detects current process as running and invalid pid as not running', () => {
    assert.equal(isProcessRunning(process.pid), true);
    // PID 99999999 is overwhelmingly unlikely to exist
    assert.equal(isProcessRunning(99999999), false);
  });

  it('acquires lock and releases it cleanly', () => {
    process.env.BTC_LOCK_DIR = testDir;
    const lock = acquireInstanceLock('test-instance-1');
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.instanceId, 'test-instance-1');

    const lockFile = path.join(testDir, 'bot.lock');
    assert.equal(fs.existsSync(lockFile), true);

    lock.release();
    assert.equal(fs.existsSync(lockFile), false);
  });

  it('rejects concurrent acquisition if lock is already held by a running process', () => {
    process.env.BTC_LOCK_DIR = testDir;
    const lock1 = acquireInstanceLock('test-instance-first');

    assert.throws(
      () => {
        acquireInstanceLock('test-instance-second');
      },
      /Another bot instance/
    );

    lock1.release();
  });
});
