export interface Indicators {
  ema20: number; ema50: number; rsi14: number; atr14: number;
  adx: number; bbUpper: number; bbMiddle: number; bbLower: number;
  volumeAvg: number;
}
/**
 * 行情质量评分 (0-100)
 *   ATR趋势(30分) + K线质量(25分) + 多周期一致性(30分) + 资金费率(15分)
 *   高质量 = 趋势清晰适合交易，低质量 = 震荡/纠结/假信号
 */
export function calcMarketQuality(
  candles1h: number[][],
  candles15m: number[][],
  candles5m: number[][],
  fundingRate: number = 0,
): number {
  if (candles1h.length < 6) return 50; // 数据不足，给中性分
  let score = 0;

  // 1. ATR 趋势 (30分)：ATR放大=波动释放有方向，ATR收窄=蓄势等突破
  const atr = (h: number[], l: number[], c: number[], n: number) => {
    let sum = 0;
    for (let i = 1; i <= n; i++)
      sum += Math.max(h[h.length-i] - l[l.length-i],
        Math.abs(h[h.length-i] - c[c.length-i-1]),
        Math.abs(l[l.length-i] - c[c.length-i-1]));
    return sum / n;
  };
  const h1 = candles1h.map(x => x[2]), l1 = candles1h.map(x => x[3]), c1 = candles1h.map(x => x[4]);
  const atrRecent = atr(h1, l1, c1, 5);
  const atrOld = atr(h1, l1, c1.slice(0, -5), 5);
  if (atrRecent > atrOld * 1.15) score += 30;
  else if (atrRecent > atrOld * 1.02) score += 20;
  else if (atrRecent > atrOld * 0.90) score += 10;

  // 2. K线质量 (25分)：实体占比高=方向明确，影线长=多空争夺
  const bodyRatio = candles1h.slice(-6).map(c => {
    const body = Math.abs(c[4] - c[1]);
    const range = c[2] - c[3];
    return range > 0 ? body / range : 0;
  });
  const avgBody = bodyRatio.reduce((a,b) => a+b, 0) / bodyRatio.length;
  if (avgBody > 0.6) score += 25;
  else if (avgBody > 0.45) score += 18;
  else if (avgBody > 0.30) score += 10;

  // 3. 多周期一致性 (30分)：1h/15m/5m 方向是否一致
  const trendDir = (cs: number[][]): number => {
    if (cs.length < 5) return 0;
    const ema5 = cs.slice(-5).reduce((s,x) => s+x[4], 0) / 5;
    const ema20 = cs.slice(-Math.min(20, cs.length)).reduce((s,x) => s+x[4], 0) / Math.min(20, cs.length);
    const last = cs[cs.length-1][4];
    if (last > ema5 && ema5 > ema20) return 1;
    if (last < ema5 && ema5 < ema20) return -1;
    return 0;
  };
  const dirs = [
    trendDir(candles1h),
    trendDir(candles15m.length >= 8 ? candles15m : candles1h),
    trendDir(candles5m.length >= 12 ? candles5m : (candles15m.length >= 8 ? candles15m : candles1h)),
  ].filter(d => d !== 0);
  if (dirs.length >= 3 && new Set(dirs).size === 1) score += 30;
  else if (dirs.length >= 2 && new Set(dirs).size === 1) score += 20;
  else if (dirs.length >= 2) score += 5;

  // 4. 资金费率信号 (15分)
  const fr = Math.abs(fundingRate || 0);
  if (fr < 0.005) score += 15;
  else if (fr < 0.015) score += 8;

  return Math.min(score, 100);
}

export function calcIndicators(candles: number[][]): Indicators | null {
  const c = candles;
  if (!c || c.length < 8) return null; // 最少 8 根K线
  const close = c.map(x => x[4]), high = c.map(x => x[2]), low = c.map(x => x[3]), vol = c.map(x => x[5]);
  const last = close[close.length - 1];
  const ema20 = calcEMA(close, 20), ema50 = calcEMA(close, 50);
  const rsi14 = calcRSI(close, 14), atr14 = calcATR(high, low, close, 14);
  const adx = calcADX(high, low, close, 14);
  const bb = calcBB(close, 20, 2);
  const volumeAvg = vol.slice(-20).reduce((a, b) => a + b, 0) / 20;
  return { ema20, ema50, rsi14, atr14, adx, ...bb, volumeAvg };
}
function calcEMA(data: number[], p: number) {
  let ema = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(data: number[], p: number) {
  let g = 0, l = 0;
  for (let i = data.length - p; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function calcATR(high: number[], low: number[], close: number[], p: number) {
  let tr = 0;
  for (let i = 1; i <= p; i++)
    tr += Math.max(high[high.length - i] - low[low.length - i],
      Math.abs(high[high.length - i] - close[close.length - i - 1]),
      Math.abs(low[low.length - i] - close[close.length - i - 1]));
  return tr / p;
}
function calcBB(data: number[], p: number, m: number) {
  const slice = data.slice(-p);
  const mean = slice.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / p);
  return { bbMiddle: mean, bbUpper: mean + std * m, bbLower: mean - std * m };
}
function calcADX(high: number[], low: number[], close: number[], p: number): number {
  const dxValues: number[] = [];
  for (let i = 1; i < high.length; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    const dmP = up > down && up > 0 ? up : 0, dmM = down > up && down > 0 ? down : 0;
    const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    if (tr === 0) continue;
    const dx = Math.abs(dmP - dmM) / (dmP + dmM || 1) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < p) return 20;
  return dxValues.slice(-p).reduce((a, b) => a + b, 0) / p;
}
