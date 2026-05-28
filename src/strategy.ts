import { CONFIG } from "./config";
import { type MarketData, type Position, type AccountInfo } from "./exchanges";
import { calcIndicators } from "./indicators";
import { setAtrCache, setRsiCache } from "./state";

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
    const entryBand = Math.max(at * 0.6, 0.5);
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
        // 多空矛盾：日线多/1h空 → 按1h方向做空；日线空/1h多 → 按1h方向做多
        // 用更低置信度、更保守评分
        if (isUp) {
          // 日线多、1h空 → 检查做空
          if (maDist >= -entryBand * 0.6 && maDist <= entryBand) {
            sc = -5 - Math.round(at * 3);
            sig = "sell";
            re = `${regime}/1h空/反弹${entryMaName}(${maDist.toFixed(2)}%)`;
            cf = 0.55;
          } else if (maDist < -entryBand * 0.6) {
            sc = -4 - Math.round(at * 2); sig = "sell"; re = `${regime}/1h空/追空(${maDist.toFixed(2)}%)`; cf = 0.45;
          } else {
            re = `${regime}/1h空/突破${entryMaName}观望`;
          }
        } else {
          // 日线空、1h多 → 检查做多
          if (maDist >= -entryBand && maDist <= entryBand * 0.6) {
            sc = 5 + Math.round(at * 3);
            sig = "buy";
            re = `${regime}/1h多/回踩${entryMaName}(${maDist.toFixed(2)}%)`;
            cf = 0.55;
          } else if (maDist > entryBand * 0.6) {
            sc = 4 + Math.round(at * 2); sig = "buy"; re = `${regime}/1h多/追多(${maDist.toFixed(2)}%)`; cf = 0.45;
          } else {
            re = `${regime}/1h多/跌破${entryMaName}观望`;
          }
        }
      } else if (isUp && !hasPos) {
        if (maDist >= -entryBand && maDist <= entryBand * 0.6) {
          const isStrong = regime.startsWith("强趋势");
          sc = Math.round((8 + Math.round(at * 5)) * (isStrong ? 1.0 : 0.65));
          sig = "buy";
          re = `${regime}/回踩${entryMaName}(${maDist.toFixed(2)}%)`;
          cf = isStrong ? 0.85 : 0.7;
        } else if (maDist > entryBand * 0.6) {
          sc = 4 + Math.round(at * 2); sig = "buy"; re = `${regime}/追多(${maDist.toFixed(2)}%)`; cf = 0.45;
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
          sc = -4 - Math.round(at * 2); sig = "sell"; re = `${regime}/追空(${maDist.toFixed(2)}%)`; cf = 0.45;
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
    const kl = `支撑${(p - i1.atr14 * 2).toFixed(2)} 阻力${(p + i1.atr14 * 2).toFixed(2)}`;
    const td = regime === "纯震荡"
      ? "纯震荡不开仓"
      : `${regime}/回踩1h${entryMaName}`;
    a.push({ symbol: sym, regime: rl, score: sc, trend: sig === "buy" ? "bullish" : sig === "sell" ? "bearish" : "neutral", strength: Math.abs(sc) >= 7 ? "strong" : Math.abs(sc) >= 4 ? "moderate" : "weak", keyLevels: kl, summary: re, analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: td, analysis_1d: adxDesc(id.adx) });
    if (sig !== "hold") {
      // 超涨/超跌检查：偏离 3 ATR 以上 + RSI 极端 → 禁止同方向开仓
      const atrMult = Math.abs(maDist) / Math.max(at, 0.01);
      const isShort = sig === "sell";
      if ((isShort && maDist < 0 && atrMult >= 3 && i1.rsi14 < 30) ||
          (!isShort && maDist > 0 && atrMult >= 3 && i1.rsi14 > 70)) {
        sig = "hold";
        re = `${regime}/${isShort?"超跌反弹":"超涨回调"}风险(偏离${Math.abs(maDist).toFixed(1)}%×${atrMult.toFixed(1)}ATR RSI${i1.rsi14.toFixed(0)}), 禁止开仓并考虑平仓`;
        cf = 0;
      }
    }
    if (sig !== "hold") {
      // 按行情类型动态计算杠杆
      let leverageMult = 1.0;
      if (regime === "强趋势多" || regime === "强趋势空") leverageMult = 1.0;
      else if (regime === "弱趋势多" || regime === "弱趋势空") leverageMult = 0.7;
      else leverageMult = 0.4; // 震荡偏多/空
      const dynLeverage = Math.min(CONFIG.maxLeverage,
        Math.round(CONFIG.defaultLeverage * leverageMult)
      );
      nt.push({ action: sig, symbol: sym, leverage: dynLeverage, amountPercent: 5, reason: re, confidence: cf, score: sc, stopLossPct: 3, takeProfitPct: 6, regime: rl });
    }
  }

  const pc: PCmd[] = [];
  for (const pos of positions) {
    const t = tickers.get(pos.symbol); if (!t) continue;
    const o = ohlcv.get(pos.symbol); const c = o?.["1h"] ? ca(o["1h"]) : []; const i = calcIndicators(c);
    if (!i) { pc.push({ symbol: pos.symbol, action: "hold", reason: "数据不足", confidence: 0.5 }); continue; }
    let ac: "hold" | "close" = "hold", rr = "";
    // 出场由监控循环的 ATR 止损 + 跟踪止盈接管，策略不主动平仓
    rr = "持有中";
    pc.push({ symbol: pos.symbol, action: ac, reason: rr, confidence: 0.8 });
  }
  return { analysis: a, positions: pc, newTrades: nt, summary: `【策略周期】${a.length}币种 ${pc.filter(x=>x.action!=="hold").length}持仓指令 ${nt.length}交易信号` };
}
