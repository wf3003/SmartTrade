/**
 * SmartTrade - 日志系统 (pino)
 * 同时输出到控制台（彩色）和文件
 */
import pino from "pino";
import { CONFIG } from "./config";
import fs from "fs";
import path from "path";

// 确保日志目录存在（基于数据库所在目录的 logs/ 子目录）
const DATA_DIR = path.dirname(path.resolve(CONFIG.databaseUrl.replace("file:", "")));
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, "smarttrade.log");

export const logger = pino({
  level: CONFIG.logLevel,
  transport: {
    targets: [
      {
        target: "pino-pretty",
        level: CONFIG.logLevel,
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
      {
        target: "pino/file",
        level: "trace",
        options: {
          destination: LOG_FILE,
          mkdir: true,
          append: true,
        },
      },
    ],
  },
});
