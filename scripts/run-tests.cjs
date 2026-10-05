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

[alertsDir, stateDir, logsDir, lockDir, reportsDir].forEach((dir) => {
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
};

const result = spawnSync(
  process.execPath,
  ['--require', 'ts-node/register', '--test', 'src/**/*.test.ts'],
  {
    stdio: 'inherit',
    env,
    shell: true,
  }
);

process.exit(result.status !== null ? result.status : 1);
