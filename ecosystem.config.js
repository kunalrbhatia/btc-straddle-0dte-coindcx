/**
 * PM2 app definitions for the CoinDCX BTC bots.
 *
 * ACTIVE — 1 DTE: sells an OTM strangle whose premium sits in the $100–150 band, entering 22:45 IST
 * and exiting 17:45 IST the next day. It runs continuously: its own scheduler arms the daily entry,
 * so PM2 needs no cron_restart (a restart mid-cycle would needlessly interrupt a live position, and
 * the bot re-reads session.token per request and resumes from its state file on boot anyway).
 *
 * RETIRED — 0 DTE (2026-10-11): deliberately left OUT of the app list below, so that the most common
 * command (`pm2 start ecosystem.config.js`) can no longer bring it back. Its entry point additionally
 * refuses to run unless I_ACCEPT_0DTE_RISK=true is set — see src/index.ts.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Retained for reference: the old 0 DTE design restarted the process shortly before its entry so the
 * bot picked up a fresh process/session. The 1 DTE bot does not need it (see the note above).
 */
function computeCronRestart(
  execHourStr = process.env.EXECUTION_HOUR_IST,
  execMinuteStr = process.env.EXECUTION_MINUTE_IST,
  leadMinutesStr = process.env.RESTART_LEAD_MINUTES
) {
  const hour = execHourStr !== undefined && execHourStr !== '' ? Number(execHourStr) : 18;
  const minute = execMinuteStr !== undefined && execMinuteStr !== '' ? Number(execMinuteStr) : 15;
  const leadMinutes = leadMinutesStr !== undefined && leadMinutesStr !== '' ? Number(leadMinutesStr) : 45;

  const totalMinutes = hour * 60 + minute;
  const restartTotalMinutes = ((totalMinutes - leadMinutes) % 1440 + 1440) % 1440;
  const restartHour = Math.floor(restartTotalMinutes / 60);
  const restartMinute = restartTotalMinutes % 60;

  return `${restartMinute} ${restartHour} * * *`;
}

module.exports = {
  computeCronRestart,
  apps: [
    // ---------------------------------------------------------------- 1 DTE (ACTIVE)
    {
      name: 'straddle-1dte',
      script: './dist/oneDte/index.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=512',
      autorestart: true,
      stop_exit_codes: [0],
      exp_backoff_restart_delay: 100,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-1dte-error.log',
      out_file: './logs/pm2-1dte-out.log',
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata',
      },
    },

    // ------------------------------------------------------- 0 DTE (RETIRED — DO NOT RE-ENABLE)
    // Kept as documentation only. Restoring this block would let a plain
    // `pm2 start ecosystem.config.js` open live 0 DTE positions again.
    //
    // {
    //   name: 'straddle-btc-0dte',
    //   script: './dist/index.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   node_args: '--max-old-space-size=512',
    //   autorestart: true,
    //   cron_restart: computeCronRestart(), // fresh process before entry (PM2 cron uses LOCAL time = IST)
    //   stop_exit_codes: [0],
    //   exp_backoff_restart_delay: 100,
    //   watch: false,
    //   max_memory_restart: '512M',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   error_file: './logs/pm2-error.log',
    //   out_file: './logs/pm2-out.log',
    //   min_uptime: '10s',
    //   max_restarts: 10,
    //   kill_timeout: 10000,
    //   env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' },
    // },
  ],
};
