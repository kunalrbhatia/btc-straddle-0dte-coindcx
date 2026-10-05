const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

function computeCronRestart(
  execHourStr = process.env.EXECUTION_HOUR_IST,
  execMinuteStr = process.env.EXECUTION_MINUTE_IST,
  leadMinutesStr = process.env.RESTART_LEAD_MINUTES
) {
  const hour = execHourStr !== undefined && execHourStr !== '' ? Number(execHourStr) : 18;
  const minute = execMinuteStr !== undefined && execMinuteStr !== '' ? Number(execMinuteStr) : 15;
  const leadMinutes = leadMinutesStr !== undefined && leadMinutesStr !== '' ? Number(leadMinutesStr) : 45;

  const totalMinutes = hour * 60 + minute;
  // Handle wrap-around across midnight (1440 minutes in a day)
  const restartTotalMinutes = ((totalMinutes - leadMinutes) % 1440 + 1440) % 1440;
  const restartHour = Math.floor(restartTotalMinutes / 60);
  const restartMinute = restartTotalMinutes % 60;

  return `${restartMinute} ${restartHour} * * *`;
}

const cronRestart = computeCronRestart();
console.log(`[PM2 Ecosystem] Configured cron_restart: '${cronRestart}' (derived from ${process.env.EXECUTION_HOUR_IST ?? 18}:${process.env.EXECUTION_MINUTE_IST ?? 15} IST with ${process.env.RESTART_LEAD_MINUTES ?? 45}m lead)`);

module.exports = {
  computeCronRestart,
  apps: [
    {
      name: 'straddle-btc-0dte',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=512',
      autorestart: true,
      cron_restart: cronRestart, // fresh process before entry (PM2 cron uses LOCAL time = IST)
      stop_exit_codes: [0],
      exp_backoff_restart_delay: 100,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata',
      },
    },
  ],
};
