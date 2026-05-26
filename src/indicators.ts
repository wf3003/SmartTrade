export interface Indicators {
  ema20: number; ema50: number; rsi14: number; atr14: number;
  adx: number; bbUpper: number; bbMiddle: number; bbLower: number;
  volumeAvg: number;
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
  let dxSum = 0, dxCount = 0;
  for (let i = 1; i < high.length; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    const dmP = up > down && up > 0 ? up : 0, dmM = down > up && down > 0 ? down : 0;
    const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    if (tr === 0) continue;
    const dx = Math.abs(dmP - dmM) / (dmP + dmM || 1) * 100;
    if (dxCount >= p) { dxSum -= dxSum / p; dxSum += dx; } else { dxSum += dx; dxCount++; }
  }
  return dxCount > 0 ? dxSum / dxCount : 20;
}
