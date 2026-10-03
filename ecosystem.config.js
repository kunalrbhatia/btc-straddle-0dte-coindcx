module.exports = {
  apps: [
    {
      name: 'straddle-btc-0dte',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=512',
      autorestart: true,
      cron_restart: '0 12 * * *', // Daily fresh restart at 12:00 UTC (5:30 PM IST), 45m before 6:15 PM IST execution
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
