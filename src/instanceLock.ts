import fs from 'fs';
import path from 'path';

/**
 * Single-instance lock via PID file.
 * Prevents multiple bot instances (e.g. local CLI + PM2 or duplicate processes)
 * from racing against each other and placing/cancelling each other's orders.
 */

export function getLockDir(): string {
  return process.env.BTC_LOCK_DIR
    ? path.resolve(process.env.BTC_LOCK_DIR)
    : path.resolve(process.cwd(), 'state');
}

export function getLockFilePath(): string {
  return path.join(getLockDir(), 'bot.lock');
}

export interface InstanceLock {
  readonly pid: number;
  readonly acquiredAt: string;
  readonly instanceId: string;
  release: () => void;
}

/**
 * Checks if a process with the given PID is currently active.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // process.kill(pid, 0) tests for process existence without killing it
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    return error.code === 'EPERM'; // Running, but not permitted to signal
  }
}

/**
 * Attempts to acquire an exclusive lock file for this bot process.
 * If another live process holds the lock, throws an Error.
 * If a stale lock exists from a terminated process, cleans it up.
 */
export function acquireInstanceLock(instanceId = `bot-${process.pid}-${Date.now()}`): InstanceLock {
  const lockDir = getLockDir();
  const lockFile = getLockFilePath();

  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  if (fs.existsSync(lockFile)) {
    try {
      const content = fs.readFileSync(lockFile, 'utf8');
      const data = JSON.parse(content) as { pid: number; acquiredAt: string; instanceId: string };
      if (typeof data.pid === 'number' && isProcessRunning(data.pid)) {
        throw new Error(
          `Another bot instance (PID ${data.pid}, Instance ID: ${data.instanceId || 'unknown'}) is currently running! Lock file held at: ${lockFile}`
        );
      }
      // Process is dead, stale lock
      console.warn(`[InstanceLock] Found stale lock from dead PID ${data.pid}. Cleaning up.`);
      fs.unlinkSync(lockFile);
    } catch (err) {
      if ((err as Error).message.includes('Another bot instance')) {
        throw err;
      }
      // If parsing failed or corrupted file, remove it
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Ignore
      }
    }
  }

  const payload = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    instanceId,
  };

  // Write with wx flag (exclusive creation)
  try {
    fs.writeFileSync(lockFile, JSON.stringify(payload, null, 2), { flag: 'wx' });
  } catch (writeErr) {
    throw new Error(`Failed to acquire instance lock at ${lockFile}: ${(writeErr as Error).message}`);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(lockFile)) {
        const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number };
        if (cur.pid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch {
      // Ignore release error on exit
    }
  };

  return {
    pid: process.pid,
    acquiredAt: payload.acquiredAt,
    instanceId,
    release,
  };
}
