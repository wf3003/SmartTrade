/**
 * ShangAI 策略类型定义 — 移植到 SmartTrade2
 * 多智能体策略的信号类型、技术指标、交易决策
 */

export type AgentRole = "trend" | "arbitrage" | "hedge" | "market_making" | "reversion";

export interface TechnicalIndicators {
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  atrPct: number;
  adx: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  macdSignal: "金叉" | "死叉" | "顶背离" | "底背离" | "无信号";
  volumeRatio: number;
}

export interface StrategySignal {
  agentId: string;
  agentRole: AgentRole;
  symbol: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  reason: string;
  indicators: TechnicalIndicators;
  suggestedLeverage: number;
  suggestedAmountPct: number;
  timestamp: number;
}

export interface TradeDecision {
  signal: StrategySignal;
  riskApproved: boolean;
  adjustedLeverage: number;
  adjustedAmountPct: number;
  vetoReason?: string;
}

/** 市场快照（简化版，适配 SmartTrade2 数据结构） */
export interface MarketSnapshot {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  fundingRate: number;
  closes_1h: number[];
  highs_1h: number[];
  lows_1h: number[];
  volumes_1h: number[];
  closes_1d: number[];
  highs_1d: number[];
  lows_1d: number[];
  volumes_1d: number[];
}

/** 新策略引擎输出 — 兼容 SmartTrade2 AI 管道 */
export interface SymbolAnalysis {
  symbol: string;
  trendSignal: StrategySignal;
  decision: TradeDecision | null;
  regime: string;
  marketQuality: number;
  summary: string;
}

export interface NewStrategyReport {
  analyses: SymbolAnalysis[];
  summary: string;
  aiPromptContext: string;
}
