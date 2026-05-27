/**
 * PM2 生态配置文件
 *
 * 使用方式：
 *   pm2 start ecosystem.config.js              # 启动（不带 Web）
 *   pm2 start ecosystem.config.js --env web     # 启动（带 Web 仪表盘）
 *   pm2 restart smarttrade                      # 重启
 *   pm2 logs smarttrade                         # 查看日志
 *   pm2 save                                    # 保存进程列表
 */
export default {
  apps: [
    {
      name: "smarttrade",
      script: "dist/index.js",
      cwd: ".",
      args: "",
      env: {
        NODE_ENV: "production",
      },
      env_web: {
        NODE_ENV: "production",
        args: "--web",
      },
      error_file: "data/logs/pm2-error.log",
      out_file: "data/logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      autorestart: true,
      max_restarts: 5,
      watch: false,
      time: true,
    },
  ],
};
