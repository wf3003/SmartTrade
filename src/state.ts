/**
 * SmartTrade - 共享状态
 */
import { logger } from "./logger";
import { CONFIG } from "./config";
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

// ===== 指标缓存（供 snapshot + opt_rules 消费） =====

export interface IndicatorSnapshotData {
  regime: string;
  rsi_1h: number;
  rsi_1d: number;
  adx_1h: number;
  adx_1d: number;
  atr_pct: number;
  ema_dist_pct: number;
}
export const indicatorCache = new Map<string, IndicatorSnapshotData>();
export function setIndicatorCache(symbol: string, data: IndicatorSnapshotData) {
  indicatorCache.set(symbol, data);
}

// ===== AI 复盘反馈 — 动态参数调优 =====
// 每次复盘后更新，让入场参数更准确，不替代止损

/** 币种评分乘数 (默认1.0，连败币种调低) */
export const symbolScoreMult = new Map<string, number>();

/** 信号类型惩罚分 (如 追空→扣4分) */
export const signalScorePenalty = new Map<string, number>();

// ===== opt_rules 缓存（从 DB 加载，复盘后刷新） =====
export let optRulesCache: any[] = [];

/** 从 DB 加载规则到缓存 */
export async function loadOptRulesFromDb(): Promise<void> {
  const { getActiveOptRules } = await import("./db");
  optRulesCache = getActiveOptRules();
  logger.info(`⚙️ 已加载 ${optRulesCache.length} 条优化规则`);
}

/** 在 index.ts 中每次开仓前调用：对评分应用 opt_rules */
export function applyOptRules(
  symbol: string, side: string, baseScore: number,
  rsi_1h: number, adx_1h: number, rsi_1d: number, adx_1d: number,
  atrPct: number, emaDistPct: number, fundingRate: number,
  volume24h: number, marketQuality: number, entryQuality: number,
  currentRegime: string = "unknown"
): { score: number; logs: string[] } {
  let score = baseScore;
  const logs: string[] = [];
  // 硬编码安全网：始终生效，且区分方向
  // RSI<20 只对做空降权（超卖追空危险），做多不降（抄底合理）
  if (side === "short") {
    const v_rsi = getIndicatorValue("rsi_1h", rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v_rsi !== null && v_rsi < 20) { score = Math.round(score * 0.3); logs.push("[硬]RSI<20 做空 ×0.3"); }
    const v_fr = getIndicatorValue("funding_rate", rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v_fr !== null && v_fr < -0.03) { score = Math.round(score * 0.4); logs.push("[硬]费率<-0.03% 做空 ×0.4"); }
  }
  // RSI>80 只对做多降权（超买追多危险），做空不降（摸顶合理）
  if (side === "long") {
    const v_rsi = getIndicatorValue("rsi_1h", rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v_rsi !== null && v_rsi > 80) { score = Math.round(score * 0.3); logs.push("[硬]RSI>80 做多 ×0.3"); }
    const v_fr = getIndicatorValue("funding_rate", rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v_fr !== null && v_fr > 0.03) { score = Math.round(score * 0.4); logs.push("[硬]费率>0.03% 做多 ×0.4"); }
  }
  // 收集当前行情下已匹配的 indicator（防 "all" 规则与特定行情规则叠加）
  const matchedIndicators = new Set<string>();
  for (const rule of optRulesCache) {
    // 先处理行情特定规则
    if (rule.regime !== "all" && rule.regime !== currentRegime) continue;
    if (rule.regime !== "all") matchedIndicators.add(`${rule.indicator}:${rule.operator}:${rule.val1}`);
  }
  for (const rule of optRulesCache) {
    // "all" 规则只在无行情特定规则冲突时才应用
    if (rule.regime === "all" && matchedIndicators.has(`${rule.indicator}:${rule.operator}:${rule.val1}`)) continue;
    if (rule.regime !== "all" && rule.regime !== currentRegime) continue;
    let matches = false;
    const v = getIndicatorValue(rule.indicator, rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v === null) continue;
    if (rule.operator === "lt" && v < rule.val1) matches = true;
    else if (rule.operator === "gt" && v > rule.val1) matches = true;
    else if (rule.operator === "between" && v >= rule.val1 && v <= (rule.val2 ?? rule.val1)) matches = true;
    else if (rule.operator === "lte" && v <= rule.val1) matches = true;
    else if (rule.operator === "gte" && v >= rule.val1) matches = true;
    if (!matches) continue;
    if (rule.target === "score" || rule.target === "all") {
      if (rule.impact_type === "multiply") score = Math.round(score * rule.impact_value);
      else if (rule.impact_type === "subtract") score -= rule.impact_value;
      else if (rule.impact_type === "add") score += rule.impact_value;
      else if (rule.impact_type === "cap") score = Math.min(score, rule.impact_value);
      else if (rule.impact_type === "floor") score = Math.max(score, rule.impact_value);
      logs.push(`${rule.indicator}${rule.operator}${rule.val1} → ${rule.impact_type} ${rule.impact_value}`);
    }
  }
  return { score: Math.max(0, Math.min(100, score)), logs };
}

function getIndicatorValue(
  name: string,
  rsi_1h: number, adx_1h: number, rsi_1d: number, adx_1d: number,
  atrPct: number, emaDistPct: number, fundingRate: number,
  volume24h: number, marketQuality: number, entryQuality: number
): number | null {
  const m: Record<string, number> = {
    rsi_1h, adx_1h, rsi_1d, adx_1d,
    atr_pct: atrPct, ema_dist_pct: emaDistPct,
    funding_rate: fundingRate, volume_24h: volume24h,
    market_quality: marketQuality, entry_quality: entryQuality,
  };
  return m[name] ?? null;
}

/** 获取调整后的评分（供 strategy.ts 消费） */
export function getAdjustedScore(symbol: string, baseScore: number, reason: string): number {
  let score = baseScore;
  const sm = symbolScoreMult.get(symbol);
  if (sm !== undefined) score = Math.round(score * sm);
  for (const [pattern, penalty] of signalScorePenalty) {
    if (reason.includes(pattern)) {
      score -= Math.sign(score) * penalty;
    }
  }
  return Math.max(0, Math.min(100, score));
}

/** 获取规则中匹配"position"目标的仓位乘数 */
export function getPositionRuleMultiplier(
  symbol: string, side: string,
  rsi_1h: number, adx_1h: number, rsi_1d: number, adx_1d: number,
  atrPct: number, emaDistPct: number, fundingRate: number,
  volume24h: number, marketQuality: number, entryQuality: number,
  currentRegime: string = "unknown"
): number {
  // 防 "all" 规则与行情规则叠加（同 applyOptRules）
  const matchedPosIndicators = new Set<string>();
  for (const r of optRulesCache) {
    if (r.regime !== "all" && r.regime !== currentRegime) continue;
    if (r.target !== "position" && r.target !== "all") continue;
    if (r.regime !== "all") matchedPosIndicators.add(`${r.indicator}:${r.operator}:${r.val1}`);
  }
  let mult = 1.0;
  for (const rule of optRulesCache) {
    if (rule.regime === "all" && matchedPosIndicators.has(`${rule.indicator}:${rule.operator}:${rule.val1}`)) continue;
    if (rule.regime !== "all" && rule.regime !== currentRegime) continue;
    if (rule.target !== "position" && rule.target !== "all") continue;
    const v = getIndicatorValue(rule.indicator, rsi_1h, adx_1h, rsi_1d, adx_1d, atrPct, emaDistPct, fundingRate, volume24h, marketQuality, entryQuality);
    if (v === null) continue;
    let matches = false;
    if (rule.operator === "lt" && v < rule.val1) matches = true;
    else if (rule.operator === "gt" && v > rule.val1) matches = true;
    else if (rule.operator === "between" && v >= rule.val1 && v <= (rule.val2 ?? rule.val1)) matches = true;
    else if (rule.operator === "lte" && v <= rule.val1) matches = true;
    else if (rule.operator === "gte" && v >= rule.val1) matches = true;
    if (matches && rule.impact_type === "multiply") mult *= rule.impact_value;
  }
  return mult;
}

/** 重置所有动态参数 */
export function resetDynamicParams() {
  symbolScoreMult.clear();
  signalScorePenalty.clear();
  optRulesCache = [];
  logger.info(`⚙️ 动态参数已重置为默认值`);
}

/** 应用 AI 复盘建议 */
export function applyReviewSuggestions(suggestions: string[]): void {
  for (const s of suggestions) {
    const levNumMatch = s.match(/杠杆.*?(?:降至|降到|调至|调到|下调到|降低到|设定为|设为)\s*(\d+)\s*[倍xX]?/);
    if (levNumMatch) {
      const target = parseInt(levNumMatch[1]);
      leverageMult = Math.max(0.3, Math.min(1.5, target / CONFIG.defaultLeverage));
      logger.info(`⚙️ 复盘→杠杆调至${target}x: leverageMult=${leverageMult.toFixed(2)}`);
    } else if (/(降低|减少|下调|调低|减小)\s*(杠杆|倍数)/.test(s)) {
      leverageMult = Math.max(0.5, leverageMult - 0.15);
      logger.info(`⚙️ 复盘→降低杠杆: leverageMult=${leverageMult.toFixed(2)}`);
    } else if (/(提高|增加|上调|调高|加大)\s*(杠杆|倍数)/.test(s) || /杠杆过低/.test(s)) {
      leverageMult = Math.min(1.5, leverageMult + 0.15);
      logger.info(`⚙️ 复盘→提高杠杆: leverageMult=${leverageMult.toFixed(2)}`);
    }
    const slNumMatch = s.match(/止损.*?(?:收窄至|收紧至|缩小到|设置为|设为|调到|放宽到|放大到|扩大到|扩大到|扩大至)\s*(\d+)\s*%/);
    if (slNumMatch) {
      const target = parseInt(slNumMatch[1]) / 100;
      stopLossMult = Math.max(0.5, Math.min(1.5, target / 8));
      logger.info(`⚙️ 复盘→止损调至${parseInt(slNumMatch[1])}%: stopLossMult=${stopLossMult.toFixed(2)}`);
    } else if (/(收紧|收窄|缩小|减小|过[大宽])\s*(止损|止蚀)/.test(s)) {
      stopLossMult = Math.max(0.5, stopLossMult - 0.1);
      logger.info(`⚙️ 复盘→收紧止损: stopLossMult=${stopLossMult.toFixed(2)}`);
    } else if (/(放宽|放大|扩大|拉宽|增加|提高|过[窄小])\s*(止损|止蚀)/.test(s)) {
      stopLossMult = Math.min(1.5, stopLossMult + 0.2);
      logger.info(`⚙️ 复盘→放宽止损: stopLossMult=${stopLossMult.toFixed(2)}`);
    }
    if (/(提高|提升|上调|增加|抬高)\s*[^。]*(?:信心|阈值|门槛|置信度|入场要求)/.test(s)) {
      confidenceOffset = Math.min(0.15, confidenceOffset + 0.05);
      logger.info(`⚙️ 复盘→提高信心阈值: confidenceOffset=${confidenceOffset.toFixed(2)}`);
    }
    if (/(降低|减少|下调|减低|放宽)\s*[^。]*(?:信心|阈值|门槛|置信度|入场要求)/.test(s)) {
      confidenceOffset = Math.max(0, confidenceOffset - 0.05);
      logger.info(`⚙️ 复盘→降低信心阈值: confidenceOffset=${confidenceOffset.toFixed(2)}`);
    }
  }
}

/** 根据逐币种分析调整评分乘数 */
export function applySymbolAnalysis(bySymbol: {symbol: string; analysis: string}[]): void {
  const mentioned = new Set(bySymbol.map(bs => bs.symbol));
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

/** 从复盘 blockSymbols 对指定币种降权 */
export function applyBlockSymbols(blockSymbols: string[]): void {
  for (const sym of blockSymbols) {
    if (typeof sym !== "string") continue;
    const cur = symbolScoreMult.get(sym) ?? 1.0;
    if (cur <= 0.3) continue;
    const nv = Math.max(0.3, cur - 0.4);
    symbolScoreMult.set(sym, nv);
    logger.info(`⚙️ ${sym} 复盘→blockSymbols 降权 scoreMult=${nv.toFixed(2)}`);
  }
}

/** 从 blockSignals 提取信号类型惩罚 */
export function applyBlockSignals(blockSignals: string): void {
  if (blockSignals.includes("追空")) {
    signalScorePenalty.set("追空", 8);
    logger.info(`⚙️ 复盘→追空信号-8分`);
  }
  if (blockSignals.includes("追涨") || blockSignals.includes("追多")) {
    signalScorePenalty.set("追多", 4);
    signalScorePenalty.set("追涨", 4);
    logger.info(`⚙️ 复盘→追多/追涨信号-4分`);
  }
  if (blockSignals.includes("sync")) {
    signalScorePenalty.set("sync_rebuild", 4);
    signalScorePenalty.set("sync_closed", 4);
    logger.info(`⚙️ 复盘→sync_rebuild/sync_closed信号-4分`);
  }
}

/** 全局杠杆乘数 */
export let leverageMult = 1.0;
/** 止损距离乘数 */
export let stopLossMult = 1.0;
/** 入场置信度下限偏移 */
export let confidenceOffset = 0;
/** AI复盘评分校准建议 */
export let scoringAdvice = "";

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

// ===== 基于历史胜率的仓位乘数 =====
export const symbolPositionMult = new Map<string, number>();

/** 根据历史交易胜率更新仓位乘数 */
export function applyWinRateReward(trades: any[]): void {
  const N = 15;
  const minTrades = 3;
  const bySymbol: Record<string, { pnls: number[]; wins: number }> = {};
  for (const t of (trades || [])) {
    if (t.status !== "closed") continue;
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnls: [], wins: 0 };
    if (bySymbol[t.symbol].pnls.length >= N) continue;
    bySymbol[t.symbol].pnls.push(t.pnl || 0);
    if ((t.pnl || 0) > 0) bySymbol[t.symbol].wins++;
  }
  for (const [sym, data] of Object.entries(bySymbol)) {
    const total = data.pnls.length;
    if (total < minTrades) continue;
    const winRate = data.wins / total;
    const totalPnl = data.pnls.reduce((s, v) => s + v, 0);
    let mult = 1.0;
    if (winRate >= 0.80 && total >= 5) { mult = 2.0; logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x2.0`); }
    else if (winRate >= 0.65 && total >= 4) { mult = 1.5; logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x1.5`); }
    else if (winRate >= 0.50 && total >= 4) { mult = 1.2; logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) → 仓位x1.2`); }
    else if (winRate <= 0.20 && total >= 3) { mult = 0.3; logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x0.3`); }
    else if (winRate <= 0.35 && total >= 3) { mult = 0.5; logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x0.5`); }
    symbolPositionMult.set(sym, mult);
  }
}

/** 启动时强制覆盖硬性惩罚 */
export function ensureHardPenalties(): void {
  if (!signalScorePenalty.has("sync_rebuild")) {
    signalScorePenalty.set("sync_rebuild", 4);
    signalScorePenalty.set("sync_closed", 4);
    logger.info(`⚙️ 启动覆盖→sync_rebuild/sync_closed信号-4分`);
  }
}

// ===== 持久化 =====

export async function saveFeedbackToDb(extra?: Record<string, any>): Promise<void> {
  const { saveFeedbackState } = await import("./db");
  const payload = JSON.stringify({
    ...(extra || {}),
    symbolScoreMult: Object.fromEntries(symbolScoreMult),
    symbolPositionMult: Object.fromEntries(symbolPositionMult),
    signalScorePenalty: Object.fromEntries(signalScorePenalty),
    leverageMult,
    stopLossMult,
    confidenceOffset,
    scoringAdvice,
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
    if (data.symbolPositionMult) for (const [k, v] of Object.entries(data.symbolPositionMult)) symbolPositionMult.set(k, v as number);
    if (data.signalScorePenalty) for (const [k, v] of Object.entries(data.signalScorePenalty)) signalScorePenalty.set(k, v as number);
    if (typeof data.leverageMult === "number") leverageMult = data.leverageMult;
    if (typeof data.stopLossMult === "number") stopLossMult = data.stopLossMult;
    if (typeof data.confidenceOffset === "number") confidenceOffset = data.confidenceOffset;
    if (typeof data.scoringAdvice === "string" && data.scoringAdvice) scoringAdvice = data.scoringAdvice;
    logger.info(`⚙️ 已恢复复盘反馈参数: leverageMult=${leverageMult.toFixed(2)} stopLossMult=${stopLossMult.toFixed(2)} symbolScoreMult=${symbolScoreMult.size}项`);
  } catch {}
}
