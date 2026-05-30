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
    if (s.includes("降低杠杆") || s.includes("杠杆上限") || s.includes("减少杠杆")) {
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

/** 根据逐币种分析调整评分乘数，未提及币种自动恢复 0.1 */
export function applySymbolAnalysis(bySymbol: {symbol: string; analysis: string}[]): void {
  const mentioned = new Set(bySymbol.map(bs => bs.symbol));
  // 未提及的币种向 1.0 回归（低于 0.5 快恢复 0.2，以上慢恢复 0.1）
  for (const [sym, cur] of symbolScoreMult) {
    if (!mentioned.has(sym) && cur < 1.0) {
      const step = cur < 0.5 ? 0.2 : 0.1;
      const nv = Math.min(1.0, cur + step);
      symbolScoreMult.set(sym, nv);
      logger.info(`⚙️ ${sym} 未在复盘问题列表，scoreMult 回归 ${cur.toFixed(1)}→${nv.toFixed(1)}`);
    }
  }
  for (const bs of bySymbol) {
    const sym = bs.symbol;
    const analysis = bs.analysis || "";
    let penalty = 0;
    if (analysis.includes("全败") || analysis.includes("全部止损")) penalty = 0.4;
    else if (analysis.includes("应避免") || analysis.includes("禁止交易") || analysis.includes("建议禁止")) penalty = 0.4;
    else if (analysis.includes("停止交易") || analysis.includes("建议暂停")) penalty = 0.3;
    else if (analysis.includes("净亏损最大") || analysis.includes("完全失效")) penalty = 0.3;
    if (penalty > 0) {
      const cur = symbolScoreMult.get(sym) ?? 1.0;
      const nv = Math.max(0.3, cur - penalty);
      symbolScoreMult.set(sym, nv);
      logger.info(`⚙️ ${sym} 复盘"${analysis.slice(0,30)}" → scoreMult=${nv.toFixed(2)}`);
    }
  }
}

/** 从复盘 blockSymbols 对指定币种降权（已因 bySymbol 降权到底的不重复降） */
export function applyBlockSymbols(blockSymbols: string[]): void {
  for (const sym of blockSymbols) {
    if (typeof sym !== "string") continue;
    const cur = symbolScoreMult.get(sym) ?? 1.0;
    if (cur <= 0.3) continue; // 已被 applySymbolAnalysis 降到底，不重复
    const nv = Math.max(0.3, cur - 0.4);
    symbolScoreMult.set(sym, nv);
    logger.info(`⚙️ ${sym} 复盘→blockSymbols 降权 scoreMult=${nv.toFixed(2)}`);
  }
}

/** 从 blockSignals 提取信号类型惩罚 */
export function applyBlockSignals(blockSignals: string): void {
  if (blockSignals.includes("追空")) {
    signalScorePenalty.set("追空", 4);
    logger.info(`⚙️ 复盘→追空信号-4分`);
  }
  if (blockSignals.includes("追涨") || blockSignals.includes("追多")) {
    signalScorePenalty.set("追多", 4);
    signalScorePenalty.set("追涨", 4);
    logger.info(`⚙️ 复盘→追多/追涨信号-4分`);
  }
}

/** 获取币种调整后的评分 */
export function getAdjustedScore(symbol: string, baseScore: number, reason: string): number {
  let score = baseScore;
  const sm = symbolScoreMult.get(symbol);
  if (sm !== undefined) score = Math.round(score * sm);
  for (const [pattern, penalty] of signalScorePenalty) {
    if (reason.includes(pattern)) {
      // 惩罚分始终朝0方向推：正分减、负分加
      score -= Math.sign(score) * penalty;
    }
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

// ===== 持久化：启动恢复 + 复盘后保存 =====

export async function saveFeedbackToDb(extra?: Record<string, any>): Promise<void> {
  const { saveFeedbackState } = await import("./db");
  const payload = JSON.stringify({
    ...(extra || {}),
    symbolScoreMult: Object.fromEntries(symbolScoreMult),
    signalScorePenalty: Object.fromEntries(signalScorePenalty),
    leverageMult,
    stopLossMult,
    confidenceOffset,
  });
  saveFeedbackState(payload);
}

export async function loadFeedbackFromDb(): Promise<void> {
  const { loadFeedbackState } = await import("./db");
  const raw = loadFeedbackState();
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data.symbolScoreMult) for (const [k, v] of Object.entries(data.symbolScoreMult)) symbolScoreMult.set(k, v as number);
    if (data.signalScorePenalty) for (const [k, v] of Object.entries(data.signalScorePenalty)) signalScorePenalty.set(k, v as number);
    if (typeof data.leverageMult === "number") leverageMult = data.leverageMult;
    if (typeof data.stopLossMult === "number") stopLossMult = data.stopLossMult;
    if (typeof data.confidenceOffset === "number") confidenceOffset = data.confidenceOffset;
    logger.info(`⚙️ 已恢复复盘反馈参数: leverageMult=${leverageMult.toFixed(2)} stopLossMult=${stopLossMult.toFixed(2)} symbolScoreMult=${symbolScoreMult.size}项`);
  } catch {}
}
