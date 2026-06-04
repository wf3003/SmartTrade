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

/** AI复盘评分校准建议（给AI决策参考） */
export let scoringAdvice = "";

/** 重置所有动态参数到默认值 */
export function resetDynamicParams() {
  symbolScoreMult.clear();
  signalScorePenalty.clear();
  leverageMult = 1.0;
  stopLossMult = 1.0;
  confidenceOffset = 0;
  logger.info(`⚙️ 动态参数已重置为默认值`);
}

/** 应用 AI 复盘建议 — 翻译为参数调整（正则匹配，支持提取数值） */
export function applyReviewSuggestions(suggestions: string[]): void {
  for (const s of suggestions) {
    // ===== 杠杆 =====
    // 提取具体倍数的模式：降至3x、降到2倍、杠杆调低到4
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

    // ===== 止损 =====
    // 提取具体百分比：收窄至4%、止损设到5%
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

    // ===== 信心阈值 =====
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

// ===== 基于历史胜率的仓位乘数 =====
// 根据每个币种最近 N 笔已平仓交易的胜率自动调整仓位大小

/** 币种仓位乘数（默认1.0，高胜率提升，低胜率降低） */
export const symbolPositionMult = new Map<string, number>();

/** 根据历史交易胜率更新仓位乘数 */
export function applyWinRateReward(trades: any[]): void {
  const N = 15; // 取最近 N 笔
  const minTrades = 3; // 最少需要几笔才计算

  // 按币种分组，只取最近 N 笔已平仓的交易
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
    if (winRate >= 0.80 && total >= 5) {
      mult = 2.0;
      logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x2.0`);
    } else if (winRate >= 0.65 && total >= 4) {
      mult = 1.5;
      logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x1.5`);
    } else if (winRate >= 0.50 && total >= 4) {
      mult = 1.2;
      logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) → 仓位x1.2`);
    } else if (winRate <= 0.20 && total >= 3) {
      mult = 0.3;
      logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x0.3`);
    } else if (winRate <= 0.35 && total >= 3) {
      mult = 0.5;
      logger.info(`⚙️ ${sym} 胜率${(winRate*100).toFixed(0)}%(${data.wins}W/${total-data.wins}L) PnL:$${totalPnl.toFixed(2)} → 仓位x0.5`);
    }

    symbolPositionMult.set(sym, mult);
  }
}

/** 启动时强制覆盖硬性惩罚（不受旧持久化数据干扰） */
export function ensureHardPenalties(): void {
  // 追空惩罚由AI+回测决定，不再硬编码扣8分
  if (!signalScorePenalty.has("sync_rebuild")) {
    signalScorePenalty.set("sync_rebuild", 4);
    signalScorePenalty.set("sync_closed", 4);
    logger.info(`⚙️ 启动覆盖→sync_rebuild/sync_closed信号-4分`);
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
