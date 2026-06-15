/**
 * 规则驱动策略 — ADX/EMA 趋势跟随 + 多周期回测
 * 替代 AI 选方向：回测已验证趋势市延续策略准确率 70%
 */
import { logger } from "../logger";

export interface AiTradeSignal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  stopLoss: number;
  takeProfit: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
}

// ─── 轻量指标计算 ───

function sma(arr: number[], p: number): number[] {
  const r: number[] = new Array(arr.length).fill(NaN);
  for (let i = p - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j];
    r[i] = s / p;
  }
  return r;
}

function ema(arr: number[], span: number, startIdx: number): number[] {
  const r: number[] = new Array(arr.length).fill(NaN);
  const k = 2 / (span + 1);
  let e = 0; for (let i = startIdx; i < startIdx + span; i++) e += arr[i];
  e /= span;
  r[startIdx + span - 1] = e;
  for (let i = startIdx + span; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); r[i] = e; }
  return r;
}

/** ADX(14) 计算 */
function adx(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const n = closes.length;
  const adxOut: number[] = new Array(n).fill(NaN);
  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
  }
  const atrEma = ema(tr, period, 1);
  const plusDMEma = ema(plusDM, period, 1);
  const minusDMEma = ema(minusDM, period, 1);
  for (let i = period * 2; i < n; i++) {
    if (atrEma[i] <= 0) continue;
    const pdi = (plusDMEma[i] / atrEma[i]) * 100;
    const mdi = (minusDMEma[i] / atrEma[i]) * 100;
    const dx = Math.abs(pdi - mdi) / (pdi + mdi) * 100;
    adxOut[i] = dx;
  }
  const adxSmooth = ema(adxOut.filter(x => !isNaN(x)), period, 0);
  let si = 0;
  for (let i = 0; i < n; i++) {
    if (!isNaN(adxOut[i])) { adxOut[i] = adxSmooth[si] || adxOut[i]; si++; }
  }
  return adxOut;
}

// ─── 规则决策（零 AI 调用） ───

export async function aiSignalDecision(
  symbol: string, tfData: Record<string, any[]>, fundingRate: number,
): Promise<AiTradeSignal | null> {
  return ruleBasedDecision(symbol, tfData, fundingRate);
}

/** 纯规则趋势跟随：ADX判强弱 + EMA判方向 + 回测延续 > 反转 */
export function ruleBasedDecision(
  symbol: string, tfData: Record<string, any[]>, _fundingRate: number,
): AiTradeSignal | null {
  // 用 1h K线判断大趋势，15m 判断入场时机
  const tf1h = tfData["1h"];
  const tf15m = tfData["15m"] || tfData["5m"];
  if (!tf1h || tf1h.length < 60) { logger.debug(symbol + " 1h数据不足"); return null; }
  if (!tf15m || tf15m.length < 30) { logger.debug(symbol + " 15m数据不足"); return null; }

  const hc = tf1h.map((c: any) => c.close ?? c[4]);
  const hh = tf1h.map((c: any) => c.high ?? c[2]);
  const hl = tf1h.map((c: any) => c.low ?? c[3]);
  const mc = tf15m.map((c: any) => c.close ?? c[4]);
  const mh = tf15m.map((c: any) => c.high ?? c[2]);
  const ml = tf15m.map((c: any) => c.low ?? c[3]);
  const price = mc[mc.length - 1];
  const hn = hc.length;

  // ── 1h 级别指标 ──
  const adx1h = adx(hh, hl, hc, 14);
  const curAdx = adx1h[hn - 1] || 30;
  const ema20h = ema(hc, 20, 0); const ema50h = ema(hc, 50, 0);
  const curEma20 = ema20h[hn - 1]; const curEma50 = ema50h[hn - 1];
  const dailyUp = !isNaN(curEma20) && !isNaN(curEma50) && curEma20 > curEma50;

  // ── 15m 级别回测：判断延续 vs 反转 ──
  const mn = mc.length;
  const contAcc = quickBacktest(mh, ml, mc, "continuation");
  const revAcc = quickBacktest(mh, ml, mc, "reversal");
  const preferCont = contAcc > revAcc + 5; // 延续显著优于反转

  // ── 规则决策 ──
  const adxDesc = curAdx >= 50 ? "强趋势" : curAdx >= 40 ? "趋势明确" : curAdx >= 25 ? "弱趋势" : "震荡";
  const dirDesc = dailyUp ? "偏多" : "偏空";

  // 硬止损/止盈：ADX越高仓位越重（由 signalToTrade 统一处理）
  const slPct = curAdx >= 50 ? 0.05 : 0.04;
  const tpPct = curAdx >= 50 ? 0.12 : 0.08;

  if (curAdx >= 50 && preferCont) {
    // 🔥 强趋势 + 延续主导 → 顺势开仓（回测准确率 70%）
    if (dailyUp) {
      return {
        symbol, action: "buy",
        stopLoss: price * (1 - slPct), takeProfit: price * (1 + tpPct),
        confidence: "HIGH",
        reason: `${adxDesc}(ADX${curAdx.toFixed(0)})/${dirDesc} 回测延续${contAcc.toFixed(0)}%>反转${revAcc.toFixed(0)}% → 顺势做多`,
      };
    } else {
      return {
        symbol, action: "sell",
        stopLoss: price * (1 + slPct), takeProfit: price * (1 - tpPct),
        confidence: "HIGH",
        reason: `${adxDesc}(ADX${curAdx.toFixed(0)})/${dirDesc} 回测延续${contAcc.toFixed(0)}%>反转${revAcc.toFixed(0)}% → 顺势做空`,
      };
    }
  }

  if (curAdx >= 40 && preferCont) {
    // 📊 趋势明确 + 延续主导 → 中等信心
    if (dailyUp) {
      return {
        symbol, action: "buy",
        stopLoss: price * (1 - slPct), takeProfit: price * (1 + tpPct),
        confidence: "MEDIUM",
        reason: `${adxDesc}(ADX${curAdx.toFixed(0)})/${dirDesc} 延续${contAcc.toFixed(0)}% → 顺势做多`,
      };
    } else {
      return {
        symbol, action: "sell",
        stopLoss: price * (1 + slPct), takeProfit: price * (1 - tpPct),
        confidence: "MEDIUM",
        reason: `${adxDesc}(ADX${curAdx.toFixed(0)})/${dirDesc} 延续${contAcc.toFixed(0)}% → 顺势做空`,
      };
    }
  }

  // 弱趋势/震荡/反转主导 → 不交易
  logger.debug(`${symbol}: ${adxDesc}/${dirDesc} cont${contAcc.toFixed(0)}% rev${revAcc.toFixed(0)}% → HOLD`);
  return {
    symbol, action: "hold",
    stopLoss: 0, takeProfit: 0,
    confidence: "LOW",
    reason: `${adxDesc}/${dirDesc} cont=${contAcc.toFixed(0)}% rev=${revAcc.toFixed(0)}% → 观望`,
  };
}

/** 简单回测：统计延续/反转策略在最近 N 根K线中的方向准确率 */
function quickBacktest(highs: number[], lows: number[], closes: number[], strategy: "continuation" | "reversal"): number {
  const n = closes.length;
  const lookback = Math.min(30, n - 5);
  if (lookback < 10) return 50;
  let correct = 0, total = 0;
  for (let i = n - lookback; i < n - 3; i++) {
    const priceNow = closes[i];
    const priceFuture = closes[Math.min(i + 3, n - 1)]; // 3根后
    const trendUp = i >= 5 && sma(closes, 5)[i] > sma(closes, 20)[i];
    const change = priceFuture - priceNow;
    total++;
    if (strategy === "continuation") {
      // 延续：上涨趋势继续涨 = 正确
      if ((trendUp && change > 0) || (!trendUp && change < 0)) correct++;
    } else {
      // 反转：上涨趋势转跌 = 正确
      if ((trendUp && change < 0) || (!trendUp && change > 0)) correct++;
    }
  }
  return total > 0 ? (correct / total) * 100 : 50;
}
