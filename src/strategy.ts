import { CONFIG } from "./config";
import { type MarketData, type Position, type AccountInfo } from "./exchanges";
import { calcIndicators, calcMarketQuality, checkExtremeDeviation } from "./indicators";
import { setAtrCache, setRsiCache, getAdjustedScore, getAdjustedLeverage, getAdjustedConfidenceFloor } from "./state";
import { logger } from "./logger";

type S = "buy" | "sell" | "hold";

interface TradeSignal { action: S; symbol: string; leverage: number; amountPercent: number; reason: string; confidence: number; score: number; stopLossPct: number; takeProfitPct: number; regime: string; }
interface CoinSignal { symbol: string; regime: string; score: number; trend: string; strength: string; keyLevels: string; summary: string; analysis_1m: string; analysis_5m: string; analysis_15m: string; analysis_1h: string; analysis_1d: string; }
interface PCmd { symbol: string; action: S | "close" | "close_partial"; closePercent?: number; reason: string; confidence: number; }
export interface StrategyReport { analysis: CoinSignal[]; positions: PCmd[]; newTrades: TradeSignal[]; summary: string; execution?: { log: string[] }; }

function ca(d: { open: number; high: number; low: number; close: number }[]): number[][] { return d.map(c => [0, 0, c.high, c.low, c.close, 0]); }
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
  ohlcv: Map<string, Record<string, { open: number; high: number; low: number; close: number }[]>>,
  positions: Position[],
  account: AccountInfo,
): Promise<StrategyReport | null> {
  const a: CoinSignal[] = [], nt: TradeSignal[] = [];
  const es = new Set(positions.map(p => p.symbol));
  for (const sym of CONFIG.symbols) {
    const t = tickers.get(sym); if (!t) continue;
    const o = ohlcv.get(sym);
    const c1h = o?.["1h"] ? ca(o["1h"]) : [], c1d = o?.["1d"] ? ca(o["1d"]) : [];
    const p = t.price, i1 = calcIndicators(c1h), id = calcIndicators(c1d);
    const m1 = ch(o?.["1m"]), m5 = ch(o?.["5m"]), m15 = ch(o?.["15m"]);
    if (!i1 || !id) { a.push({ symbol: sym, regime: "数据不足", score: 0, trend: "neutral", strength: "weak", keyLevels: "", summary: "数据不足", analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: "", analysis_1d: "" }); continue; }
    // 缓存 1h ATR% 供监控循环的止损用
    const at = i1.atr14 / p * 100;
    setAtrCache(sym, at / 100); // 存为小数（如 0.015 = 1.5%）
    setRsiCache(sym, i1.rsi14);
    // ===== 日线方向过滤 + 动态回调入场 =====
    const dailyUp = id.ema20 > id.ema50;
    const dailyAdx = id.adx;
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
    let rl = "", sig: S = "hold", sc = 0, re = "", cf = 0;

    if (regime === "纯震荡") {
      rl = regime;
      re = `ADX${dailyAdx.toFixed(0)}<18 纯震荡不交易`;
    } else if (regime === "震荡偏多" || regime === "震荡偏空") {
      rl = regime;
      const hasPos = es.has(sym);
      if (regime === "震荡偏空") {
        // 震荡偏空——禁止做多，仅允许做空
        if (hasPos) {
          re = `震荡偏空/已有持仓持有中`;
        } else if (maDist >= -entryBand * 0.6 && maDist <= entryBand) {
          sc = -5 - Math.round(at * 3);
          sig = "sell";
          re = `震荡偏空/反弹${entryMaName}(${maDist.toFixed(2)}%)`;
          cf = 0.6;
        } else if (maDist < -entryBand * 0.6) {
          sc = -4 - Math.round(at * 2); sig = "sell"; re = `震荡偏空/追空(${maDist.toFixed(2)}%)`; cf = 0.45;
        } else {
          re = `震荡偏空/突破${entryMaName}观望`;
        }
      } else {
        // 震荡偏多——禁止做空，仅允许做多
        if (hasPos) {
          re = `震荡偏多/已有持仓持有中`;
        } else if (maDist >= -entryBand && maDist <= entryBand * 0.6) {
          sc = 5 + Math.round(at * 3);
          sig = "buy";
          re = `震荡偏多/回踩${entryMaName}(${maDist.toFixed(2)}%)`;
          cf = 0.6;
        } else if (maDist > entryBand * 0.6) {
          sc = 4 + Math.round(at * 2); sig = "buy"; re = `震荡偏多/追多(${maDist.toFixed(2)}%)`; cf = 0.45;
        } else {
          re = `震荡偏多/跌破${entryMaName}观望`;
        }
      }
    } else if (regime.startsWith("强趋势") || regime.startsWith("弱趋势")) {
      rl = regime;
      const isUp = regime.includes("多");
      const hasPos = es.has(sym);
      // 1h 时间框架一致性检查
      const h1Aligned = i1 && (isUp ? i1.ema20 > i1.ema50 : i1.ema20 < i1.ema50);
      if (!h1Aligned && !hasPos) {
        // 多空矛盾：日线多/1h空 或 日线空/1h多
        // 日线 ADX ≥ 60 置信度高 → 顺日线方向开仓
        if (dailyAdx >= 60 && isUp) {
          if (maDist >= -entryBand && maDist <= entryBand * 0.6) {
            sc = Math.round((8 + Math.round(at * 5)) * 1.0);
            sig = "buy";
            re = `${regime}/日线ADX${dailyAdx.toFixed(0)}≥60/顺日线做多/回踩${entryMaName}(${maDist.toFixed(2)}%)`;
            cf = 0.7;
          } else {
            re = `${regime}/日线ADX${dailyAdx.toFixed(0)}≥60/离${entryMaName}${Math.abs(maDist).toFixed(1)}%等回调`;
          }
        } else if (dailyAdx >= 60) {
          if (maDist >= -entryBand * 0.6 && maDist <= entryBand) {
            sc = Math.round((-8 - Math.round(at * 5)) * 1.0);
            sig = "sell";
            re = `${regime}/日线ADX${dailyAdx.toFixed(0)}≥60/顺日线做空/反弹${entryMaName}(${maDist.toFixed(2)}%)`;
            cf = 0.7;
          } else {
            re = `${regime}/日线ADX${dailyAdx.toFixed(0)}≥60/离${entryMaName}${Math.abs(maDist).toFixed(1)}%等反弹`;
          }
        } else {
          // 日线弱趋势(ADX<60) + 方向矛盾 → 不交易，避免强多看跌之类的反直觉信号
          re = `${regime}/日线ADX${dailyAdx.toFixed(0)}<60/1h方向矛盾，等待信号一致`;
        }
      } else if (isUp && !hasPos) {
        if (maDist >= -entryBand && maDist <= entryBand * 0.6) {
          const isStrong = regime.startsWith("强趋势");
          sc = Math.round((8 + Math.round(at * 5)) * (isStrong ? 1.0 : 0.65));
          sig = "buy";
          re = `${regime}/回踩${entryMaName}(${maDist.toFixed(2)}%)`;
          cf = isStrong ? 0.85 : 0.7;
        } else if (maDist > entryBand * 0.6) {
          const isStrong = regime.startsWith("强趋势");
          sc = 4 + Math.round(at * 2); sig = "buy"; re = `${regime}/追多(${maDist.toFixed(2)}%)`; cf = isStrong ? 0.55 : 0.45;
        } else {
          re = `${regime}/跌破${entryMaName}观望`;
        }
      } else if (!isUp && !hasPos) {
        if (maDist >= -entryBand * 0.6 && maDist <= entryBand) {
          const isStrong = regime.startsWith("强趋势");
          sc = Math.round((-8 - Math.round(at * 5)) * (isStrong ? 1.0 : 0.65));
          sig = "sell";
          re = `${regime}/反弹${entryMaName}(${maDist.toFixed(2)}%)`;
          cf = isStrong ? 0.85 : 0.7;
        } else if (maDist < -entryBand * 0.6) {
          const isStrong = regime.startsWith("强趋势");
          sc = -4 - Math.round(at * 2); sig = "sell"; re = `${regime}/追空(${maDist.toFixed(2)}%)`; cf = isStrong ? 0.55 : 0.45;
        } else {
          re = `${regime}/突破${entryMaName}观望`;
        }
      } else {
        re = `${regime}/已有持仓持有中`;
      }
    } else {
      rl = regime;
      re = `已有持仓或等信号`;
    }
    // 超涨/超跌检查（在 a.push 前执行，确保 summary 正确显示）
    if (sig !== "hold") {
      const extreme = checkExtremeDeviation(maDist, at, i1.rsi14, sig === "sell" ? "short" : "long", 3);
      if (extreme.hit) {
        sig = "hold"; sc = 0; cf = 0;
        re = `${regime}/${extreme.label}风险(${extreme.detail})`;
      }
    }
    const kl = `支撑${(p - i1.atr14 * 2).toFixed(2)} 阻力${(p + i1.atr14 * 2).toFixed(2)}`;
    const td = regime === "纯震荡"
      ? "纯震荡不开仓"
      : `${regime}/回踩1h${entryMaName}`;
    a.push({ symbol: sym, regime: rl, score: sc, trend: sig === "buy" ? "bullish" : sig === "sell" ? "bearish" : "neutral", strength: Math.abs(sc) >= 7 ? "strong" : Math.abs(sc) >= 4 ? "moderate" : "weak", keyLevels: kl, summary: re, analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: td, analysis_1d: adxDesc(id.adx) });
    if (sig === "hold" && re) {
      logger.info(`[ST] ${sym}: ${regime} | score=${sc} sig=hold | ${re.slice(0, 60)}`);
    } else if (sig !== "hold") {
      logger.info(`[ST] ${sym}: ${regime} | score=${sc} sig=${sig} cf=${cf} | ${re.slice(0, 60)}`);
    }
    if (sig !== "hold") {
      // 按行情类型动态计算杠杆
      let leverageMult = 1.0;
      if (regime === "强趋势多" || regime === "强趋势空") leverageMult = 1.5;
      else if (regime === "弱趋势多" || regime === "弱趋势空") leverageMult = 0.7;
      else leverageMult = 0.4; // 震荡偏多/空
      // 高波动币降杠杆：ATR > 0.8% 限制倍率上限，防止损截断后价格距离过小
      //   ATR 1.15% × 1.2 × 9x = 12.42% → 截断到 10% → 实际 10% / 9x = 1.11% 就止损
      //   降为 6x 后：ATR 1.15% × 1.2 × 6x = 8.28% → 实际 8.28% / 6x = 1.38%
      const volMaxMult = at > 1.5 ? 0.7 : at > 0.8 ? 1.0 : 1.5;
      leverageMult = Math.min(leverageMult, volMaxMult);
      const dynLeverage = Math.min(CONFIG.maxLeverage,
        Math.round(CONFIG.defaultLeverage * leverageMult)
      );
      // 行情质量评分 → 动态调整仓位/杠杆/信心
      const raw1h = o?.["1h"] || [], raw15m = o?.["15m"] || [], raw5m = o?.["5m"] || [];
      const cvt = (d: {open:number;high:number;low:number;close:number}[]) =>
        d.map(x => [0, x.open, x.high, x.low, x.close, 0] as number[]);
      const fr = t.fundingRate !== undefined ? Math.abs(Number(t.fundingRate)) : 0;
      const mq = calcMarketQuality(cvt(raw1h), cvt(raw15m), cvt(raw5m), fr);
      const basePct = CONFIG.basePositionPct;
      let adjPct = basePct, adjLeverage = dynLeverage;
      if (mq >= 70) { adjPct = basePct; }                              // 高质量 → 满仓
      else if (mq >= 40) { adjPct = Math.round(basePct * 0.6); adjLeverage = dynLeverage > 6 ? dynLeverage - 2 : dynLeverage; }  // 中等 → 60%
      else if (mq >= 20) { adjPct = Math.round(basePct * 0.4); adjLeverage = dynLeverage > 4 ? dynLeverage - 3 : Math.max(dynLeverage, 2); }  // 低质量 → 40%
      else { sig = "hold"; sc = 0; re = `低行情质量(mq${mq})，跳过`; }  // 很差 → 跳过
      if (sig !== "hold") {
        // AI 复盘反馈 — 动态调整评分/杠杆/置信度
        const adjScore = getAdjustedScore(sym, sc, re);
        const adjLev = getAdjustedLeverage(adjLeverage);
        const adjCf = getAdjustedConfidenceFloor(cf);
        if (adjScore === 0) {
          logger.info(`[ADJ] ${sym} 复盘调整后 score=0，跳过 (原${sc} ${re.slice(0,30)})`);
          continue;
        }
        if (adjScore !== sc || adjLev !== adjLeverage) {
          logger.info(`[ADJ] ${sym}: score ${sc}→${adjScore} | lev ${adjLeverage}→${adjLev} | cf ${cf}→${adjCf}`);
        }
        logger.info(`[MQ] ${sym}: mq=${mq} sig=${sig} pct=${adjPct} lev=${adjLev}`);
        nt.push({ action: sig, symbol: sym, leverage: adjLev, amountPercent: adjPct, reason: re, confidence: adjCf, score: adjScore, stopLossPct: 3, takeProfitPct: 6, regime: rl, marketQuality: mq } as any);
      }
      if (mq < 20) {
        logger.info(`[MQ] ${sym}: mq=${mq} < 20 信号被行情质量拦截`);
      }
    }
  }

  const pc: PCmd[] = [];
  for (const pos of positions) {
    const t = tickers.get(pos.symbol); if (!t) continue;
    const o = ohlcv.get(pos.symbol); const c = o?.["1h"] ? ca(o["1h"]) : []; const i = calcIndicators(c);
    if (!i) { pc.push({ symbol: pos.symbol, action: "hold", reason: "数据不足", confidence: 0.5 }); continue; }
    let ac: "hold" | "close" = "hold", rr = "";
    // 极端行情检测：RSI超卖/超涨 + ATR大幅偏离时主动平仓
    const at = i.atr14 / t.price * 100;
    const maDist = (t.price - i.ema20) / i.ema20 * 100;
    const extreme = checkExtremeDeviation(maDist, at, i.rsi14, pos.side, 2.5);
    if (extreme.hit) {
      ac = "close";
      rr = `${extreme.label}风险(${extreme.detail})`;
    } else {
      rr = "持有中";
    }
    pc.push({ symbol: pos.symbol, action: ac, reason: rr, confidence: 0.8 });
  }
  // 市场偏向修正（BTC权重翻倍）：一方占比≥2/3才算主导，否则均衡不做修正
  const weight = (x: any) => x.symbol === "BTC/USDT" ? 2 : 1;
  const totalBull = a.filter(x => x.trend === "bullish").reduce((s, x) => s + weight(x), 0);
  const totalBear = a.filter(x => x.trend === "bearish").reduce((s, x) => s + weight(x), 0);
  const total = Math.max(totalBull + totalBear, 1);
  const marketBullish = totalBull / total >= 0.66;
  const marketBearish = totalBear / total >= 0.66;
  for (const t of nt) {
    if (t.action === "hold") continue;
    const isReverse = (t.action === "buy" && marketBearish) || (t.action === "sell" && marketBullish);
    if (isReverse) {
      t.confidence = Math.max(0.3, (t.confidence || 0) - 0.15);
      t.score = Math.round((t.score || 0) * 0.7);
    }
  }
  return { analysis: a, positions: pc, newTrades: nt, summary: `【策略周期】${a.length}币种 ${pc.filter(x=>x.action!=="hold").length}持仓指令 ${nt.length}交易信号` };
}
