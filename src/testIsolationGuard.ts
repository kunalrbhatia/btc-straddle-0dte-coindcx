import path from 'path';

/**
 * Returns true if the current execution is within a test context.
 * Detects Node's native test runner (via process.env.NODE_TEST_CONTEXT or
 * process.execArgv containing '--test'), or the test runner env override BTC_TEST_MODE.
 */
export function isTestContext(): boolean {
  if (process.env.BTC_TEST_MODE === '1' || process.env.BTC_TEST === '1') {
    return true;
  }
  if (Boolean(process.env.NODE_TEST_CONTEXT)) {
    return true;
  }
  if (Array.isArray(process.execArgv) && process.execArgv.includes('--test')) {
    return true;
  }
  return false;
}

/**
 * Asserts that a directory resolution is safe for test execution.
 * If running in a test context and the directory path resolves to a subdirectory
 * of the repository without an explicit test temp dir override (i.e. inside repo root),
 * throws an explicit error to prevent accidental writes or reads against live fixtures.
 */
export function assertSafeTestDirectory(dirPath: string, purpose: string): void {
  if (!isTestContext()) {
    return;
  }

  const resolved = path.resolve(dirPath);
  const repoRoot = path.resolve(process.cwd());

  // Allowed if explicitly pointing outside repo root (e.g. os.tmpdir())
  if (!resolved.startsWith(repoRoot)) {
    return;
  }

  // If resolved is inside repoRoot (e.g. repoRoot/state, repoRoot/records, repoRoot/logs)
  throw new Error(
    `[TestIsolationGuard] Refusing to use in-repo directory "${resolved}" for ${purpose} during test execution. ` +
    `Tests must isolate writes and mutable reads to a temporary directory (e.g. os.tmpdir()).`
  );
}
