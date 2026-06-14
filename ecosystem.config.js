module.exports = {
  apps: [
    {
      name: "smarttrade",
      script: "node_modules/.bin/tsx",
      args: "--env-file=.env src/index.ts",
      cwd: "/home/rose/SmartTrade2",
      env: { NODE_ENV: "production" },
      error_file: "data/logs/pm2-error.log",
      out_file: "data/logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      time: true,
    },
  ],
};
