/* eslint-disable */
// @ts-nocheck
/**
 * SuperFilter — 四重过滤：SuperTrend + A-V2 + QQEMOD + ADX盘整
 * ADX < 22 时跳过所有信号 → 只在趋势市交易
 */

function rma(d, l) { const o = new Array(d.length).fill(0); if (!d.length) return o; let s = 0; for (let i = 0; i < l && i < d.length; i++) s += d[i]; o[l - 1] = s / l; const a = 1 / l; for (let i = l; i < d.length; i++) o[i] = a * d[i] + (1 - a) * o[i - 1]; return o; }
function ema(d, p) { const o = new Array(d.length).fill(0); if (!d.length) return o; let st = 0; while (st < d.length && isNaN(d[st])) st++; if (st >= d.length) return o; o[st] = d[st]; const a = 2 / (p + 1); for (let i = st + 1; i < d.length; i++) { const v = isNaN(d[i]) ? o[i - 1] : d[i]; o[i] = a * v + (1 - a) * o[i - 1]; } return o; }
function smaN(d, p) { const o = new Array(d.length).fill(NaN); if (d.length < p) return o; let s = 0; for (let i = 0; i < d.length; i++) { if (i >= p) s -= d[i - p]; s += d[i]; if (i >= p - 1) o[i] = s / p; } return o; }
function std2(d, p) { const o = new Array(d.length).fill(NaN); if (d.length < p) return o; for (let i = p - 1; i < d.length; i++) { const sl = d.slice(i - p + 1, i + 1); const m = sl.reduce((a, b) => a + b, 0) / p; o[i] = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p); } return o; }
function rsiC(c, l) { const o = new Array(c.length).fill(NaN); if (c.length <= l) return o; const g = [], x = []; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(d > 0 ? d : 0); x.push(d < 0 ? -d : 0); } const ag = rma(g, l), al = rma(x, l); for (let i = 0; i < ag.length; i++) { const idx = i + l; if (idx >= c.length) break; o[idx] = 100 - 100 / (1 + (al[i] === 0 ? 100 : ag[i] / al[i])); } return o; }
function calcADX(h, lw, c, p = 14) { const n = c.length; const tr = new Array(n).fill(0); for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - lw[i], Math.abs(h[i] - c[i - 1]), Math.abs(lw[i] - c[i - 1])); tr[0] = h[0] - lw[0]; const atr = rma(tr, p); const pd = new Array(n).fill(0), md = new Array(n).fill(0); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = lw[i - 1] - lw[i]; if (up > dn && up > 0) pd[i] = up; else pd[i] = 0; if (dn > up && dn > 0) md[i] = dn; else md[i] = 0; } const sp = rma(pd, p), sm = rma(md, p); const adx = new Array(n).fill(0); for (let i = p * 2; i < n; i++) { const pi = (sp[i] / atr[i]) * 100; const ni = (sm[i] / atr[i]) * 100; adx[i] = Math.abs(pi - ni) / (pi + ni) * 100; } return adx; }

export function supertrend(highs, lows, closes, period = 7, mult = 3.0) { const n = closes.length; const src = highs.map((h, i) => (h + lows[i]) / 2); const tr = new Array(n).fill(0); for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])); tr[0] = highs[0] - lows[0]; const atr = rma(tr, period); const up = new Array(n).fill(NaN), dn = new Array(n).fill(NaN), trend = new Array(n).fill(1); const buySig = new Array(n).fill(false), sellSig = new Array(n).fill(false); for (let i = 1; i < n; i++) { const ui = src[i] - mult * atr[i], di = src[i] + mult * atr[i]; const u1 = isNaN(up[i - 1]) ? ui : up[i - 1], d1 = isNaN(dn[i - 1]) ? di : dn[i - 1]; up[i] = closes[i - 1] > u1 ? Math.max(ui, u1) : ui; dn[i] = closes[i - 1] < d1 ? Math.min(di, d1) : di; const pv = trend[i - 1]; if (pv === -1 && closes[i] > d1) trend[i] = 1; else if (pv === 1 && closes[i] < u1) trend[i] = -1; else trend[i] = pv; if (i >= 2) { buySig[i] = trend[i] === 1 && trend[i - 1] === -1; sellSig[i] = trend[i] === -1 && trend[i - 1] === 1; } } return { up, dn, trend, buySignal: buySig, sellSignal: sellSig }; }

export function aV2(opens, highs, lows, closes, mp = 34) { const n = closes.length; const o = new Array(n).fill(0), h = new Array(n).fill(0), l = new Array(n).fill(0), c = new Array(n).fill(0); o[0] = opens[0]; c[0] = (opens[0] + highs[0] + lows[0] + closes[0]) / 4; h[0] = highs[0]; l[0] = lows[0]; for (let i = 1; i < n; i++) { c[i] = (opens[i] + highs[i] + lows[i] + closes[i]) / 4; o[i] = (o[i - 1] + c[i - 1]) / 2; h[i] = Math.max(highs[i], o[i], c[i]); l[i] = Math.min(lows[i], o[i], c[i]); } const mo = ema(o, mp), mc = ema(c, mp), mh = ema(h, mp), ml = ema(l, mp), trend = new Array(n).fill(0); for (let i = 0; i < n; i++) trend[i] = 100 * (mc[i] - mo[i]) / Math.max(mh[i] - ml[i], 1e-10); return { trend, maHigh: mh, maLow: ml, maClose: mc }; }

function calcQQE(closes, rsiL, sm, factor) { const n = closes.length; const r = rsiC(closes, rsiL), sr = ema(r, sm); const ar = new Array(n).fill(0); for (let i = 1; i < n; i++) ar[i] = (isNaN(sr[i - 1]) || isNaN(sr[i])) ? 0 : Math.abs(sr[i - 1] - sr[i]); const sar = rma(ar, rsiL * 2 - 1), dar = sar.map(v => v * factor); const lb = new Array(n).fill(NaN), sb = new Array(n).fill(NaN), dir = new Array(n).fill(0); let st = 0; while (st < n && isNaN(sr[st])) st++; for (let i = st; i < n; i++) { const nl = sr[i] - dar[i], ns = sr[i] + dar[i]; if (i === st || isNaN(lb[i - 1])) { lb[i] = nl; sb[i] = ns; } else { lb[i] = (sr[i - 1] > lb[i - 1] && sr[i] > lb[i - 1]) ? Math.max(lb[i - 1], nl) : nl; sb[i] = (sr[i - 1] < sb[i - 1] && sr[i] < sb[i - 1]) ? Math.min(sb[i - 1], ns) : ns; } if (i >= 2) { if (sr[i] > sb[i - 1] && sr[i - 1] <= sb[i - 1]) dir[i] = 1; else if (sr[i] < lb[i - 1] && sr[i - 1] >= lb[i - 1]) dir[i] = -1; else dir[i] = dir[i - 1]; } } const tl = new Array(n).fill(NaN); for (let i = 0; i < n; i++) tl[i] = dir[i] === 1 ? lb[i] : sb[i]; return { trendLine: tl, smoothedRsi: sr, direction: dir }; }

export function qqeMod(closes) { const p = calcQQE(closes, 6, 5, 3.0), s = calcQQE(closes, 6, 5, 1.61); const bd = p.trendLine.map(v => (isNaN(v) ? 0 : v) - 50); let bds = 0; while (bds < bd.length && isNaN(p.trendLine[bds])) bds++; const basis = smaN(bd, 50), dev = std2(bd, 50); const bbU = basis.map((b, i) => b + 0.35 * dev[i]), bbL = basis.map((b, i) => b - 0.35 * dev[i]); const sig = new Array(closes.length).fill(0); for (let i = 0; i < closes.length; i++) { if (isNaN(p.smoothedRsi[i]) || isNaN(bbU[i])) continue; const pa = (p.smoothedRsi[i] - 50) > bbU[i], pb = (p.smoothedRsi[i] - 50) < bbL[i]; const sa = (p.smoothedRsi[i] - 50) > 3, sb2 = (p.smoothedRsi[i] - 50) < -3; if (pa && sa) sig[i] = 1; else if (pb && sb2) sig[i] = -1; } return { primaryRSI: p.smoothedRsi, secondaryRSI: s.smoothedRsi, primaryTrend: p.direction, secondaryTrend: s.direction, signal: sig }; }

export function superFilter(opens, highs, lows, closes, cp) {
  const n = closes.length;
  const hold = { action: "hold", price: cp, stopLoss: 0, takeProfit1: 0, trailingLine: 0, regime: 0, sizeMul: 0, reason: "" };
  if (n < 100) { hold.reason = "数据不足"; return hold; }

  const adx = calcADX(highs, lows, closes, 14);
  const ax = adx[n - 1];
  
  // 行情分级 & 仓位乘数
  let regime = 0, sizeMul = 0;
  if (ax >= 40)      { regime = 3; sizeMul = 1.0; }
  else if (ax >= 30) { regime = 2; sizeMul = 0.5; }
  else if (ax >= 22) { regime = 1; sizeMul = 0.25; }
  else               { regime = 0; sizeMul = 0; hold.reason = "震荡ADX="+ax.toFixed(1); return hold; }

  const st = supertrend(highs, lows, closes, 9, 3.9);
  const av = aV2(opens, highs, lows, closes, 52);
  const i = n - 1;
  const stB = st.buySignal[i], stS = st.sellSignal[i], avG = av.trend[i] > 0;
  const regimeLabel = ["震荡","弱趋","中趋","强趋"][regime];
  const r = "ST:"+(st.trend[i]===1?"多":"空")+(stB?"▲":stS?"▼":"")+" AV2:"+(avG?"绿":"红")+" ADX:"+ax.toFixed(0)+" "+regimeLabel;

  if (stB && avG) {
    const sl = av.maLow[i]; const rsk = Math.max(cp - sl, 0.01);
    return { action: "buy", price: cp, stopLoss: sl, takeProfit1: cp + rsk * 2, trailingLine: av.maClose[i], regime, sizeMul, reason: r };
  }
  if (stS && !avG) {
    const sl = av.maHigh[i]; const rsk = Math.max(sl - cp, 0.01);
    return { action: "sell", price: cp, stopLoss: sl, takeProfit1: cp - rsk * 2, trailingLine: av.maClose[i], regime, sizeMul, reason: r };
  }
  hold.regime = regime; hold.sizeMul = sizeMul;
  hold.reason = r + " (不全)"; return hold;
}