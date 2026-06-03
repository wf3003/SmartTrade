import { CONFIG } from "./config";
import { type MarketData, type Position, type AccountInfo } from "./exchanges";
import { calcIndicators, calcMarketQuality, checkExtremeDeviation, convertCandles, isReversalConfirmed } from "./indicators";
import { setAtrCache, setRsiCache, getAdjustedScore, getAdjustedLeverage, getAdjustedConfidenceFloor } from "./state";
import { logger } from "./logger";
import { runBacktest, generateBacktestSummary, isHighQualitySignal, type BacktestResult } from "./backtest";
import { insertBacktestLog } from "./db";

type S = "buy" | "sell" | "hold";

interface TradeSignal { action: S; symbol: string; leverage: number; amountPercent: number; reason: string; confidence: number; score: number; stopLossPct: number; takeProfitPct: number; regime: string; }
interface CoinSignal { symbol: string; regime: string; score: number; trend: string; strength: string; keyLevels: string; summary: string; analysis_1m: string; analysis_5m: string; analysis_15m: string; analysis_1h: string; analysis_1d: string; }
interface PCmd { symbol: string; action: S | "close"; reason: string; confidence: number; }
export interface StrategyReport { analysis: CoinSignal[]; positions: PCmd[]; newTrades: TradeSignal[]; summary: string; execution?: { log: string[] }; backtestSummaries?: string[]; }

function ch(d?: { open: number; high: number; low: number; close: number }[]): string { if (!d || d.length < 2) return ""; const p = ((d[d.length-1].close - d[0].close) / d[0].close * 100); return (p >= 0 ? "涨" : "跌") + Math.abs(p).toFixed(2) + "%"; }
/** ADX → 中文趋势强度 */
function adxDesc(adx: number): string {
  if (adx >= 75) return `极强趋势(ADX${adx.toFixed(0)})`;
  if (adx >= 50) return `强趋势(ADX${adx.toFixed(0)})`;
  if (adx >= 40) return `趋势明确(ADX${adx.toFixed(0)})`;
  if (adx >= 25) return `弱趋势(ADX${adx.toFixed(0)})`;
  if (adx >= 18) return `震荡(ADX${adx.toFixed(0)})`;
  return `纯震荡(ADX${adx.toFixed(0)})`;
}

/** 行情分级：六类 */
function classifyRegime(adx: number, dailyUp: boolean, price: number, ema20: number, ema50: number): string {
  if (adx < 18) return "纯震荡";
  if (adx < 25) {
    if (dailyUp && price > ema20) return "震荡偏多";
    if (!dailyUp && price < ema20) return "震荡偏空";
    return "纯震荡";
  }
  if (adx < 40) return dailyUp ? "弱趋势多" : "弱趋势空";
  return dailyUp ? "强趋势多" : "强趋势空";
}

export async function generateStrategyReport(
  tickers: Map<string, MarketData>,
  ohlcv: Map<string, Record<string, { open: number; high: number; low: number; close: number; volume?: number }[]>>,
  positions: Position[],
  account: AccountInfo,
): Promise<StrategyReport | null> {
  const a: CoinSignal[] = [], nt: TradeSignal[] = [], btResults: BacktestResult[] = [];
  const es = new Set(positions.map(p => p.symbol));
  for (const sym of CONFIG.symbols) {
    const t = tickers.get(sym); if (!t) continue;
    const o = ohlcv.get(sym);
    const c1h = o?.["1h"] ? convertCandles(o["1h"]) : [], c1d = o?.["1d"] ? convertCandles(o["1d"]) : [];
    const p = t.price, i1 = calcIndicators(c1h), id = calcIndicators(c1d);
    const m1 = ch(o?.["1m"]), m5 = ch(o?.["5m"]), m15 = ch(o?.["15m"]);
    if (!i1 || !id) { a.push({ symbol: sym, regime: "数据不足", score: 0, trend: "neutral", strength: "weak", keyLevels: "", summary: "数据不足", analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: "", analysis_1d: "" }); continue; }
    // 缓存 1h ATR% 供监控循环的止损用
    const at = i1.atr14 / p * 100;
    setAtrCache(sym, at / 100); // 存为小数（如 0.015 = 1.5%）
    setRsiCache(sym, i1.rsi14);

    // ── 实时回测：多周期扫描，选最优 ──
    const tfMap = { "5m": o?.["5m"], "15m": o?.["15m"], "30m": o?.["30m"], "1h": o?.["1h"], "4h": o?.["4h"] };
    let bestBt: BacktestResult | null = null;
    let bestTf = "5m";
    for (const [tf, raw] of Object.entries(tfMap)) {
      const arr = raw ? convertCandles(raw) : [];
      if (arr.length < 40) continue;
      const bt = runBacktest(arr.map(x => x[4]), arr.map(x => x[2]), arr.map(x => x[3]));
      if (!bestBt || Math.abs(bt.revAccuracy - bt.contAccuracy) > Math.abs(bestBt.revAccuracy - bestBt.contAccuracy)) {
        bestBt = bt; bestTf = tf;
      }
    }
    const bt = bestBt || runBacktest([], [], []);
    logger.info(`[BT] ${sym}: 最优${bestTf}周期 ${bt.optimalStrategy} (rev${bt.revAccuracy.toFixed(0)}% vs cont${bt.contAccuracy.toFixed(0)}%, ADX~${bt.avgADX.toFixed(0)})`);
    btResults.push(bt);
    try { insertBacktestLog({ time: new Date().toISOString(), symbol: sym, optimalStrategy: bt.optimalStrategy, adxRegime: bt.adxRegime, revAccuracy: Math.round(bt.revAccuracy), contAccuracy: Math.round(bt.contAccuracy), confidence: bt.confidence, bestTf }); } catch {} // 非阻塞写库
    // ===== 日线方向过滤 + 动态回调入场 =====
    const dailyUp = id.ema20 > id.ema50;
    const dailyAdx = id.adx;
    // 日线ADX>50时强制跟随日线方向，1h回测的反转信号不适用
    // 反转标志保留给持仓管理用——已有亏损仓位仍按反转平仓
    if (bt.optimalStrategy === "reversal" && dailyAdx > 58) {
      bt.reversalSignal = true;  // 保留原始反转标志
      bt.optimalStrategy = "continuation";
      bt.confidence = Math.min(100, bt.confidence + 20);
      logger.info(`[BT] ${sym}: 日线ADX${dailyAdx.toFixed(0)}>58, 回测反转→延续`);
    }
    // 行情六类分类
    const regime = classifyRegime(dailyAdx, dailyUp, p, id.ema20, id.ema50);
    // 强趋势(ADX>50)用EMA20，普通趋势用EMA50，确保价格有机会触到
    const entryMa = dailyAdx > 50 ? i1.ema20 : i1.ema50;
    const entryMaName = dailyAdx > 50 ? "EMA20" : "EMA50";
    const maDist = (p - entryMa) / entryMa * 100;
    // 入场带按行情强度分级：强趋势放宽，震荡收紧
    let entryBand: number;
    if (dailyAdx >= 40)      entryBand = Math.max(at * 1.2, 0.8);  // 强趋势：价格偏离大时也能入场
    else if (dailyAdx >= 25) entryBand = Math.max(at * 0.8, 0.6);  // 弱趋势
    else                     entryBand = Math.max(at * 0.6, 0.5);  // 震荡
    // 取代旧评分逻辑：strategy 不再做方向判断，仅提供指标数据和执行参数
    // AI（agent.ts）基于完整指标独立做方向决策
    const kl = `支撑${(p - i1.atr14 * 2).toFixed(2)} 阻力${(p + i1.atr14 * 2).toFixed(2)}`;
    // 硬安全规则：极端偏离检查
    const extremeCheck = checkExtremeDeviation(maDist, at, i1.rsi14,
      p > i1.ema20 ? "short" : "long", 3);
    const hasExtremeRisk = extremeCheck.hit;
    // 行情质量评分（影响仓位大小，独立于方向）
    const raw1h = o?.["1h"] || [], raw15m = o?.["15m"] || [], raw5m = o?.["5m"] || [];
    const fr = t.fundingRate !== undefined ? Math.abs(Number(t.fundingRate)) : 0;
    const mq = calcMarketQuality(convertCandles(raw1h), convertCandles(raw15m), convertCandles(raw5m), fr);
    // 动态止损止盈
    const dynSlPct = Math.max(2, Math.min(8, at * 2));
    const dynTpPct = Math.max(4, Math.min(15, at * 4));
    // 动态杠杆（只看波动率）
    const volMaxMult = at > 1.5 ? 0.7 : at > 0.8 ? 1.0 : 1.5;
    const dynLeverage = Math.min(CONFIG.maxLeverage,
      Math.round(CONFIG.defaultLeverage * volMaxMult)
    );
    // 动态仓位（只看行情质量）
    const basePct = CONFIG.basePositionPct;
    let adjPct = basePct, adjLeverage = dynLeverage;
    if (mq >= 70) { adjPct = basePct; }
    else if (mq >= 40) { adjPct = Math.round(basePct * 0.6); adjLeverage = dynLeverage > 6 ? dynLeverage - 2 : dynLeverage; }
    else if (mq >= 20) { adjPct = Math.round(basePct * 0.4); adjLeverage = dynLeverage > 4 ? dynLeverage - 3 : Math.max(dynLeverage, 2); }
    // 分析摘要（纯数据描述，不做方向判断）
    const regimeDesc = `${adxDesc(dailyAdx)}${dailyUp ? '/日线偏多' : '/日线偏空'}`;
    const summaryDesc = hasExtremeRisk
      ? `${regimeDesc} ${extremeCheck.label}风险(${extremeCheck.detail})`
      : `ADX${dailyAdx.toFixed(0)} RSI${i1.rsi14.toFixed(0)} ATR${at.toFixed(2)}% 量价待AI判断`;
    // 供AI展示的行情摘要
    const mqDesc = mq >= 70 ? '高质量' : mq >= 40 ? '中等' : mq >= 20 ? '低质量' : '差';
    const td = `${regimeDesc} | 行情质量:${mqDesc}(${mq})`;
    a.push({
      symbol: sym, regime: regimeDesc, score: 0, trend: dailyUp ? "bullish" : "bearish", strength: dailyAdx >= 50 ? "strong" : dailyAdx >= 25 ? "moderate" : "weak",
      keyLevels: kl, summary: summaryDesc,
      analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: td, analysis_1d: adxDesc(id.adx),
    });
    logger.info(`[ST] ${sym}: ${regimeDesc} | 待AI判断 | ${summaryDesc.slice(0, 60)}`);
    // 生成空信号（score=0, cf=0.5）供index.ts执行循环参考，
    // AI方向复核（ai-check.ts）的评分决定是否实际执行
    const baseRe = `${regimeDesc} 待AI确认`;
    const baseScore = 0;
    const baseCf = 0.5;
    // 极低质量行情也给AI机会判断，仅记录日志
    if (mq < 20) {
      logger.info(`[MQ] ${sym}: mq=${mq} 低质量行情, 留待AI判断`);
    }
    // 多空同时发，AI自主选择方向
    nt.push({
      action: "buy",
      symbol: sym, leverage: adjLeverage, amountPercent: adjPct,
      reason: baseRe, confidence: baseCf, score: baseScore,
      stopLossPct: dynSlPct, takeProfitPct: dynTpPct,
      regime: regimeDesc, marketQuality: mq,
    } as any);
    nt.push({
      action: "sell",
      symbol: sym, leverage: adjLeverage, amountPercent: adjPct,
      reason: baseRe, confidence: baseCf, score: baseScore,
      stopLossPct: dynSlPct, takeProfitPct: dynTpPct,
      regime: regimeDesc, marketQuality: mq,
    } as any);
  }

  // 按币种建立回测结果索引
  const btMap = new Map<string, BacktestResult>();
  for (let i = 0; i < CONFIG.symbols.length; i++) {
    if (btResults[i]) btMap.set(CONFIG.symbols[i], btResults[i]);
  }

  const pc: PCmd[] = [];
  for (const pos of positions) {
    const t = tickers.get(pos.symbol); if (!t) continue;
    const o = ohlcv.get(pos.symbol); const c = o?.["1h"] ? convertCandles(o["1h"]) : []; const i = calcIndicators(c);
    if (!i) { pc.push({ symbol: pos.symbol, action: "hold", reason: "数据不足", confidence: 0.5 }); continue; }
    let ac: "hold" | "close" = "hold", rr = "";
    const at = i.atr14 / t.price * 100;
    const maDist = (t.price - i.ema20) / i.ema20 * 100;
    const posBt = btMap.get(pos.symbol);

    // 短期动量：最后5根K线持续反向 + 浮亏 → 趋势可能转坏
    // 强趋势(ADX>55)需要更深浮亏才触发，避免噪音平仓
    const pnl = pos.unrealizedPnlPct || 0;
    const flipThreshold = i.adx > 55 ? -2.5 : -1.5;
    const flipContinuation = posBt?.optimalStrategy === "continuation";
    const flip = c.length > 25 && !flipContinuation && (
      (pos.side === "long" && c[c.length-1][4] < c[c.length-6][4] && pnl < flipThreshold) ||
      (pos.side === "short" && c[c.length-1][4] > c[c.length-6][4] && pnl < flipThreshold)
    );
    if (flip) {
      ac = "close";
      rr = `5根K线趋势转向, 平仓(${pnl.toFixed(1)}%)`;
    } else
    // 【优化】延续策略主导(>15%)的币种，反转信号不触发平仓
    if (posBt && (posBt.contAccuracy - posBt.revAccuracy) > 15) {
      rr = `延续主导(c${posBt.contAccuracy.toFixed(0)}>r${posBt.revAccuracy.toFixed(0)}%),忽略反转`;
    } else if ((posBt?.optimalStrategy === "reversal" || posBt?.reversalSignal) && pnl < 3) {
      // 反转信号验证：盈利仓位需MACD/RSI/成交量确认才平
      if (pnl > 0 && c.length >= 35 && o?.["1h"]) {
        const closes = c.map(x => x[4]);
        const volumes = o["1h"].map((x: any) => x[5]);
        if (isReversalConfirmed(closes, volumes, i.rsi14, i.adx)) {
          ac = "close"; rr = `MACD/RSI确认反转,平仓(${pnl.toFixed(1)}%)`;
        } else {
          rr = `反转未确认(MACD/RSI不配合),忽略(${pnl.toFixed(1)}%)`;
        }
      } else {
        if (i.adx > 55) {
          rr = `ADX${i.adx.toFixed(0)}>55,反转不可信,忽略(${pnl.toFixed(1)}%)`;
        } else {
          ac = "close"; rr = `回测反转模式,平仓(${pnl.toFixed(1)}%)`;
        }
      }
    } else {
    // 用回测结果调整极端行情检测：延续模式不轻易平仓
    const skipClose = posBt?.optimalStrategy === "continuation" && (i.adx > 55);
    const atrMult = posBt?.optimalStrategy === "continuation" ? 4 : 2.5;
    const extreme = skipClose ? { hit: false as const, label: "", detail: "" } : checkExtremeDeviation(maDist, at, i.rsi14, pos.side, atrMult);
    if (extreme.hit) {
      ac = "close";
      rr = `${extreme.label}风险(${extreme.detail})`;
    } else {
      // RSI锁利已由浮盈保护替代，不再需要
      rr = "持有中";
    }
    }
    pc.push({ symbol: pos.symbol, action: ac, reason: rr, confidence: 0.8 });
  }
  const btSummaries = btResults.map((bt, i) => generateBacktestSummary(CONFIG.symbols[i] || "?", bt));
  // 市场偏向修正已移除（AI自行判断）
  return { analysis: a, positions: pc, newTrades: nt, summary: `【策略周期】${a.length}币种 ${pc.filter(x=>x.action!=="hold").length}持仓指令 ${nt.length}交易信号`, backtestSummaries: btSummaries };
}
