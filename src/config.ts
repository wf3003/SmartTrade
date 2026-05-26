/**
 * QuantMax - 配置管理
 * 从环境变量读取所有参数，提供类型安全的配置对象
 */
import "dotenv/config";

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}
function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? Number(v) : fallback;
}

export const CONFIG = {
  // 交易所
  exchanges: envStr("EXCHANGES", "okx,gate").split(",").map(s => s.trim()),
  
  // OKX
  okx: {
    apiKey: envStr("OKX_API_KEY", ""),
    secret: envStr("OKX_API_SECRET", ""),
    passphrase: envStr("OKX_API_PASSPHRASE", ""),
    sandbox: envStr("OKX_SANDBOX", "true") === "true",
  },
  // Gate
  gate: {
    apiKey: envStr("GATE_API_KEY", ""),
    secret: envStr("GATE_API_SECRET", ""),
    sandbox: envStr("GATE_SANDBOX", "false") === "true",
  },
  // Binance
  binance: {
    apiKey: envStr("BINANCE_API_KEY", ""),
    secret: envStr("BINANCE_API_SECRET", ""),
    sandbox: envStr("BINANCE_SANDBOX", "true") === "true",
  },

  // AI
  ai: {
    apiKey: envStr("AI_API_KEY", ""),
    baseURL: envStr("AI_BASE_URL", "https://api.deepseek.com/v1"),
    model: envStr("AI_MODEL", "deepseek-v4-flash"),
    temperature: envNum("AI_TEMPERATURE", 0.3),
    maxTokens: envNum("AI_MAX_TOKENS", 3000),
  },

  // 交易
  tradeMode: envStr("TRADE_MODE", "swap"),
  defaultLeverage: envNum("DEFAULT_LEVERAGE", 5),
  maxLeverage: envNum("MAX_LEVERAGE", 20),
  maxPositions: envNum("MAX_POSITIONS", 5),
  maxHoldingHours: envNum("MAX_HOLDING_HOURS", 36),
  initialBalance: envNum("INITIAL_BALANCE", 5000),
  symbols: envStr("SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT").split(",").map(s => s.trim()),

  // 风控
  accountStopLossUsdt: envNum("ACCOUNT_STOP_LOSS_USDT", 100),
  accountTakeProfitUsdt: envNum("ACCOUNT_TAKE_PROFIT_USDT", 20000),
  maxDrawdownPercent: envNum("MAX_DRAWDOWN_PERCENT", 30),
  dailyLossLimitUsdt: envNum("DAILY_LOSS_LIMIT_USDT", 200),

  // 分批止盈
  partialTP: {
    stage1: { trigger: envNum("PARTIAL_TP_STAGE1_TRIGGER", 10), closePercent: envNum("PARTIAL_TP_STAGE1_CLOSE", 40) },
    stage2: { trigger: envNum("PARTIAL_TP_STAGE2_TRIGGER", 20), closePercent: envNum("PARTIAL_TP_STAGE2_CLOSE", 70) },
    stage3: { trigger: envNum("PARTIAL_TP_STAGE3_TRIGGER", 30), closePercent: envNum("PARTIAL_TP_STAGE3_CLOSE", 100) },
  },

  // 服务器
  port: envNum("PORT", 3101),
  host: envStr("HOST", "0.0.0.0"),

  // 数据库
  databaseUrl: envStr("DATABASE_URL", "file:./data/quantmax.db"),

  // 日志
  logLevel: envStr("LOG_LEVEL", "info"),
} as const;
