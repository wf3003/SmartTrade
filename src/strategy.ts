import { CONFIG } from "./config";
import { type MarketData, type Position, type AccountInfo } from "./exchanges";
import { calcIndicators } from "./indicators";
import { setAtrCache } from "./state";

type S = "buy" | "sell" | "hold";

interface TradeSignal { action: S; symbol: string; leverage: number; amountPercent: number; reason: string; confidence: number; score: number; stopLossPct: number; takeProfitPct: number; }
interface CoinSignal { symbol: string; regime: string; score: number; trend: string; strength: string; keyLevels: string; summary: string; analysis_1m: string; analysis_5m: string; analysis_15m: string; analysis_1h: string; analysis_1d: string; }
interface PCmd { symbol: string; action: S | "close" | "close_partial"; closePercent?: number; reason: string; confidence: number; }
export interface StrategyReport { analysis: CoinSignal[]; positions: PCmd[]; newTrades: TradeSignal[]; summary: string; execution?: { log: string[] }; }

function ca(d: { open: number; high: number; low: number; close: number }[]): number[][] { return d.map(c => [0, 0, c.high, c.low, c.close, 0]); }
function ch(d?: { open: number; high: number; low: number; close: number }[]): string { if (!d || d.length < 2) return ""; const p = ((d[d.length-1].close - d[0].close) / d[0].close * 100); return (p >= 0 ? "涨" : "跌") + Math.abs(p).toFixed(2) + "%"; }
/** ADX → 中文趋势强度 */
function adxDesc(adx: number): string {
  if (adx >= 75) return `极强趋势(ADX${adx.toFixed(0)})`;
  if (adx >= 50) return `强趋势(ADX${adx.toFixed(0)})`;
  if (adx >= 30) return `趋势明确(ADX${adx.toFixed(0)})`;
  if (adx >= 22) return `弱趋势(ADX${adx.toFixed(0)})`;
  return `震荡(ADX${adx.toFixed(0)})`;
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
    // ===== 日线方向过滤 + EMA50 回调入场 =====
    const dailyUp = id.ema20 > id.ema50;
    const dailyAdx = id.adx;
    const ema50 = i1.ema50;
    const ema50Dist = (p - ema50) / ema50 * 100;
    let rl = "", sig: S = "hold", sc = 0, re = "", cf = 0;

    if (dailyAdx < 25) {
      rl = "日线震荡";
      re = `日线ADX${dailyAdx.toFixed(0)}<25 不交易`;
    } else if (dailyUp && !es.has(sym)) {
      rl = "日线多头";
      if (ema50Dist >= -0.5 && ema50Dist <= 0.3) {
        sc = 8 + Math.round(at * 5);
        sig = "buy";
        re = `日线多/回踩EMA50(${ema50Dist.toFixed(2)}%)`;
        cf = 0.8;
      } else if (ema50Dist > 0.3) {
        re = "日线多/等待回调";
      } else {
        re = "日线多/跌破均线观望";
      }
    } else if (!dailyUp && !es.has(sym)) {
      rl = "日线空头";
      if (ema50Dist >= -0.3 && ema50Dist <= 0.5) {
        sc = -8 - Math.round(at * 5);
        sig = "sell";
        re = `日线空/反弹EMA50(${ema50Dist.toFixed(2)}%)`;
        cf = 0.8;
      } else if (ema50Dist < -0.3) {
        re = "日线空/等待反弹";
      } else {
        re = "日线空/突破均线观望";
      }
    } else {
      rl = dailyUp ? "日线多头" : "日线空头";
      re = "已有持仓或等信号";
    }
    const kl = `支撑${(p - i1.atr14 * 2).toFixed(2)} 阻力${(p + i1.atr14 * 2).toFixed(2)}`;
    const td = dailyAdx >= 25
      ? (dailyUp ? `日均线多/回踩1hEma50` : `日均线空/反弹1hEma50`)
      : "日线震荡不开仓";
    a.push({ symbol: sym, regime: rl, score: sc, trend: sig === "buy" ? "bullish" : sig === "sell" ? "bearish" : "neutral", strength: Math.abs(sc) >= 7 ? "strong" : Math.abs(sc) >= 4 ? "moderate" : "weak", keyLevels: kl, summary: re, analysis_1m: m1, analysis_5m: m5, analysis_15m: m15, analysis_1h: td, analysis_1d: adxDesc(id.adx) });
    if (sig !== "hold") {
      const dynLeverage = Math.min(CONFIG.maxLeverage,
        Math.round(Math.abs(sc) >= 7 ? CONFIG.defaultLeverage * 1.5
                  : Math.abs(sc) >= 5 ? CONFIG.defaultLeverage * 1.2
                  : CONFIG.defaultLeverage)
      );
      nt.push({ action: sig, symbol: sym, leverage: dynLeverage, amountPercent: 5, reason: re, confidence: cf, score: sc, stopLossPct: 4, takeProfitPct: 8 });
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
