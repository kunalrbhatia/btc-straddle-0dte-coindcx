const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  ['-r', 'ts-node/register', path.join(__dirname, '..', 'src', 'acceptanceCli.ts'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
    shell: false,
  }
);

process.exit(res.status !== null ? res.status : 1);
