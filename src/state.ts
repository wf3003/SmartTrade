/**
 * SmartTrade - 共享状态
 */
import { logger } from "./logger";
export let latestReport: any = null;
export function setLatestReport(report: any) {
  latestReport = report;
}

/** 各币种 1h ATR% 缓存（策略周期计算 → 监控周期使用） */
export const atrCache = new Map<string, number>();
export function setAtrCache(symbol: string, atrPct: number) {
  atrCache.set(symbol, atrPct);
}

/** 上次获取的交易所账户/持仓数据（status 接口缓存） */
export let cachedPositions: any[] = [];
export let cachedAccount: any = {};
export function setCacheData(account: any, positions: any[]) {
  cachedAccount = account; cachedPositions = positions;
}

/** 各币种 1h RSI 缓存 */
export const rsiCache = new Map<string, number>();
export function setRsiCache(symbol: string, rsi: number) {
  rsiCache.set(symbol, rsi);
}

// ===== AI 复盘反馈 — 动态参数调优 =====
// 每次复盘后更新，让入场参数更准确，不替代止损

/** 币种评分乘数 (默认1.0，连败币种调低) */
export const symbolScoreMult = new Map<string, number>();

/** 信号类型惩罚分 (如 追空→扣4分) */
export const signalScorePenalty = new Map<string, number>();

/** 全局杠杆乘数 (默认1.0，AI建议降低杠杆时调低) */
export let leverageMult = 1.0;

/** 止损距离乘数 (默认1.0，AI建议放宽时调高) */
export let stopLossMult = 1.0;

/** 入场置信度下限偏移 (默认0，AI建议更确定时提高) */
export let confidenceOffset = 0;

/** 重置所有动态参数到默认值 */
export function resetDynamicParams() {
  symbolScoreMult.clear();
  signalScorePenalty.clear();
  leverageMult = 1.0;
  stopLossMult = 1.0;
  confidenceOffset = 0;
  logger.info(`⚙️ 动态参数已重置为默认值`);
}

/** 应用 AI 复盘建议 — 翻译为参数调整 */
export function applyReviewSuggestions(suggestions: string[]): void {
  for (const s of suggestions) {
    if (s.includes("降低杠杆")) {
      leverageMult = Math.max(0.5, leverageMult - 0.15);
      logger.info(`⚙️ 复盘→降低杠杆: leverageMult=${leverageMult.toFixed(2)}`);
    }
    if (s.includes("放宽止损")) {
      stopLossMult = Math.min(1.5, stopLossMult + 0.2);
      logger.info(`⚙️ 复盘→放宽止损: stopLossMult=${stopLossMult.toFixed(2)}`);
    }
    if ((s.includes("提高") || s.includes("增加")) && (s.includes("信心") || s.includes("阈值"))) {
      confidenceOffset = Math.min(0.15, confidenceOffset + 0.05);
      logger.info(`⚙️ 复盘→提高信心阈值: confidenceOffset=${confidenceOffset.toFixed(2)}`);
    }
  }
}

/** 根据逐币种分析调整评分乘数 */
export function applySymbolAnalysis(bySymbol: {symbol: string; analysis: string}[]): void {
  for (const bs of bySymbol) {
    const sym = bs.symbol;
    if (bs.analysis.includes("全败") || bs.analysis.includes("应避免") || bs.analysis.includes("停止交易")) {
      const cur = symbolScoreMult.get(sym) ?? 1.0;
      const nv = Math.max(0.3, cur - 0.3);
      symbolScoreMult.set(sym, nv);
      logger.info(`⚙️ ${sym} 复盘"${bs.analysis.slice(0,24)}" → scoreMult=${nv.toFixed(2)}`);
    }
  }
}

/** 从 blockSignals 提取信号类型惩罚 */
export function applyBlockSignals(blockSignals: string): void {
  if (blockSignals.includes("追空")) {
    signalScorePenalty.set("追空", 4);
    logger.info(`⚙️ 复盘→追空信号-4分`);
  }
  if (blockSignals.includes("追涨") || blockSignals.includes("追多")) {
    signalScorePenalty.set("追涨", 4);
    logger.info(`⚙️ 复盘→追涨信号-4分`);
  }
}

/** 获取币种调整后的评分 */
export function getAdjustedScore(symbol: string, baseScore: number, reason: string): number {
  let score = baseScore;
  const sm = symbolScoreMult.get(symbol);
  if (sm !== undefined) score = Math.round(score * sm);
  for (const [pattern, penalty] of signalScorePenalty) {
    if (reason.includes(pattern)) score -= penalty;
  }
  return score;
}

/** 获取调整后的杠杆 */
export function getAdjustedLeverage(baseLeverage: number): number {
  return Math.max(1, Math.round(baseLeverage * leverageMult));
}

/** 获取调整后的止损距离(%) */
export function getAdjustedStopLoss(baseStopLoss: number): number {
  return Math.round(baseStopLoss * stopLossMult * 10) / 10;
}

/** 获取调整后的置信度下限 */
export function getAdjustedConfidenceFloor(base: number): number {
  return Math.min(1, base + confidenceOffset);
}
