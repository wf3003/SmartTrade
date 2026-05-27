import { CONFIG } from "./config";
import { type MarketData, type Position, type AccountInfo } from "./exchanges";
import { calcIndicators } from "./indicators";
import { setAtrCache } from "./state";

type S = "buy" | "sell" | "hold";

interface TradeSignal { action: S; symbol: string; leverage: number; amountPercent: number; reason: string; confidence: number; stopLossPct: number; takeProfitPct: number; }
interface CoinSignal { symbol: string; regime: string; score: number; trend: string; strength: string; keyLevels: string; summary: string; analysis_1m: string; analysis_5m: string; analysis_15m: string; analysis_1h: string; analysis_1d: string; }
interface PCmd { symbol: string; action: S | "close" | "close_partial"; closePercent?: number; reason: string; confidence: number; }
export interface StrategyReport { analysis: CoinSignal[]; positions: PCmd[]; newTrades: TradeSignal[]; summary: string; execution?: { log: string[] }; }

function ca(d: { open: number; high: number; low: number; close: number }[]): number[][] { return d.map(c => [0, 0, c.high, c.low, c.close, 0]); }
function ch(d?: { open: number; high: number; low: number; close: number }[]): string { if (!d || d.length < 2) return ""; const p = ((d[d.length-1].close - d[0].close) / d[0].close * 100); return (p >= 0 ? "+" : "") + p.toFixed(2) + "%"; }

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
    const ax = id.adx, reg = ax > 30 ? "trend" : (ax >= 22 ? "weak_trend" : "range");
    let rl = "", sig: S = "hold", sc = 0, re = "", cf = 0;
    // 趋势
    if (reg === "trend") {
      const up = i1.ema20 > i1.ema50, dn = i1.ema20 < i1.ema50;
      rl = up ? "多头趋势" : "空头趋势";
      if (up && p > i1.ema20 && at < 3 && !es.has(sym)) { sc = 6 + Math.round(at * 10); sig = "buy"; re = `趋势多头/EMA20>EMA50/价格均线上方`; cf = Math.min(0.85, 0.6 + at * 8); }
      else if (dn && p < i1.ema20 && at < 3 && !es.has(sym)) { sc = -6 - Math.round(at * 10); sig = "sell"; re = `趋势空头/EMA20<EMA50/价格均线下方`; cf = Math.min(0.85, 0.6 + at * 8); }
      else re = "趋势明确,等待回调";
    } else if (reg === "weak_trend") {
      const up = i1.ema20 > i1.ema50, dn = i1.ema20 < i1.ema50;
      rl = up ? "弱多头" : "弱空头";
      if (up && at < 2 && !es.has(sym)) { sc = 4; sig = "buy"; re = "弱趋势偏多/波动收敛"; cf = 0.65; }
      else if (dn && at < 2 && !es.has(sym)) { sc = -4; sig = "sell"; re = "弱趋势偏空/波动收敛"; cf = 0.65; }
      else re = "弱趋势,等待信号";
    } else {
      // 震荡市（ADX < 22）不开趋势单
      rl = "震荡";
      re = `ADX${ax.toFixed(0)} 震荡市不开仓`;
    }
    const kl = `支撑${(p - i1.atr14 * 2).toFixed(2)} 阻力${(p + i1.atr14 * 2).toFixed(2)}`;
    const td = reg === "trend" ? (i1.ema20 > i1.ema50 ? "均线多头排列" : "均线空头排列")
      : reg === "weak_trend" ? (i1.ema20 > i1.ema50 ? "均线偏多" : "均线偏空")
      : `布林带/RSI${i1.rsi14.toFixed(0)}`;
    a.push({ symbol: sym, regime: rl, score: sc, trend: sig === "buy" ? "bullish" : sig === "sell" ? "bearish" : "neutral", strength: Math.abs(sc) >= 7 ? "strong" : Math.abs(sc) >= 4 ? "moderate" : "weak", keyLevels: kl, summary: re, analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: td, analysis_1d: `日线ADX${id.adx.toFixed(0)}` });
    if (sig !== "hold") {
      const dynLeverage = Math.min(CONFIG.maxLeverage,
        Math.round(Math.abs(sc) >= 7 ? CONFIG.defaultLeverage * 1.5
                  : Math.abs(sc) >= 5 ? CONFIG.defaultLeverage * 1.2
                  : CONFIG.defaultLeverage)
      );
      nt.push({ action: sig, symbol: sym, leverage: dynLeverage, amountPercent: 5, reason: re, confidence: cf, stopLossPct: 4, takeProfitPct: 8 });
    }
  }

  const pc: PCmd[] = [];
  for (const pos of positions) {
    const t = tickers.get(pos.symbol); if (!t) continue;
    const o = ohlcv.get(pos.symbol); const c = o?.["1h"] ? ca(o["1h"]) : []; const i = calcIndicators(c);
    if (!i) { pc.push({ symbol: pos.symbol, action: "hold", reason: "数据不足", confidence: 0.5 }); continue; }
    let ac: "hold" | "close" = "hold", rr = "";
    if (pos.side === "long" && t.price < i.ema50) { ac = "close"; rr = "跌破EMA50离场"; }
    else if (pos.side === "short" && t.price > i.ema50) { ac = "close"; rr = "突破EMA50离场"; }
    else rr = "EMA50趋势完好";
    pc.push({ symbol: pos.symbol, action: ac, reason: rr, confidence: 0.8 });
  }
  return { analysis: a, positions: pc, newTrades: nt, summary: `【策略周期】${a.length}币种 ${pc.filter(x=>x.action!=="hold").length}持仓指令 ${nt.length}交易信号` };
}
