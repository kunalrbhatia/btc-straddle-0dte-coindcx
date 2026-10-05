const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpBase = os.tmpdir();
const alertsDir = path.join(tmpBase, 'btc-test-alerts');
const stateDir = path.join(tmpBase, 'btc-test-state');
const logsDir = path.join(tmpBase, 'btc-test-logs');
const lockDir = path.join(tmpBase, 'btc-test-lock');
const reportsDir = path.join(tmpBase, 'btc-test-reports');
const recordsDir = path.join(tmpBase, 'btc-test-records');

[alertsDir, stateDir, logsDir, lockDir, reportsDir, recordsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const env = {
  ...process.env,
  BTC_ALERTS_DIR: alertsDir,
  BTC_STATE_DIR: stateDir,
  BTC_LOGS_DIR: logsDir,
  BTC_LOCK_DIR: lockDir,
  BTC_REPORTS_DIR: reportsDir,
  // The cycle-record path honours RECORD_DIR (config.recordDir); point tests at a temp dir so a
  // test run can never append to a live cycle's record in ./records.
  RECORD_DIR: recordsDir,
};

/**
 * Collect test files ourselves instead of handing a glob to the shell.
 *
 * Why (regression, 2026-10-05): the previous version passed the recursive test pattern
 * (src, then a double-star segment, then the file glob) UNQUOTED with `shell: true`. The shell
 * expanded it *before* node saw it, and without globstar a double-star behaves like a single star —
 * so it matched only files one directory deep (src/records/cycleRecord.test.ts). While no nested
 * test file existed the shell expanded to nothing, node fell back to its own glob and the full suite
 * ran; the moment #26 added the first nested test file, `npm test` silently dropped from 106 tests
 * to 10 and still reported green. An explicit file list cannot rot that way.
 */
function collectTestFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const testFiles = collectTestFiles(path.join(__dirname, '..', 'src')).sort();

if (testFiles.length === 0) {
  console.error('[run-tests] No *.test.ts files found under src/ — refusing to report success.');
  process.exit(1);
}

console.log(`[run-tests] Running ${testFiles.length} test file(s):`);
for (const f of testFiles) {
  console.log(`  - ${path.relative(path.join(__dirname, '..'), f)}`);
}

const result = spawnSync(
  process.execPath,
  ['--require', 'ts-node/register', '--test', ...testFiles],
  {
    stdio: 'inherit',
    env,
    shell: false,
  }
);

process.exit(result.status !== null ? result.status : 1);
