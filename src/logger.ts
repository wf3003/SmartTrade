/**
 * QuantMax - 日志系统 (pino)
 */
import pino from "pino";
import { CONFIG } from "./config";

export const logger = pino({
  level: CONFIG.logLevel,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});
