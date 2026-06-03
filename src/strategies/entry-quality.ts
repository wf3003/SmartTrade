/**
 * 策略4: 入场质量评分
 * 评估当前价格点是否适合入场，独立于方向判断。
 *
 * 核心维度：
 * 1. RSI极端位 — 做空时RSI<30=顺势尾端, 做多时RSI>70=追高
 * 2. BB位置 — 触及轨道=趋势可能衰竭
 * 3. 动量衰减 — ADX仍高但多周期方向已分化
 * 4. K线质量 — 影线方向指示阻力和支撑
 * 5. 成交量确认 — 放量突破可信, 缩量突破假动作
 */
import { calcIndicators, convertCandles } from "../indicators";

export interface EntryQuality {
  symbol: string;
  longEntryScore: number;
  shortEntryScore: number;
  suggestion: "favorable" | "neutral" | "unfavorable";
  warnings: string[];
  analysis: string;
}

interface TfEntryData {
  tf: string;
  rsi: number;
  adx: number;
  bbPosition: number;
  ema20Up: boolean;
  lastCandleBodyPct: number;
  lastCandleDir: "up" | "down" | "neutral";
  volRatio: number;
}

function classifyCandle(open: number, close: number, high: number, low: number): {
  dir: "up" | "down" | "neutral";
  bodyPct: number;
} {
  const range = high - low;
  if (range === 0) return { dir: "neutral", bodyPct: 0 };
  const body = Math.abs(close - open);
  const bodyPct = body / range;
  const dir = close > open ? "up" : close < open ? "down" : "neutral";
  return { dir, bodyPct };
}

function calcBbPosition(price: number, upper: number, lower: number): number {
  if (upper <= lower) return 50;
  return ((price - lower) / (upper - lower)) * 100;
}

export function assessEntryQuality(
  ohlcv: Record<string, any[]>,
  symbol: string,
): EntryQuality {
  const snapshots: TfEntryData[] = [];

  for (const tf of ["1h", "1d"]) {
    const raw = ohlcv[tf];
    if (!raw || raw.length < 15) continue;
    const arr = convertCandles(raw);
    const ind = calcIndicators(arr);
    if (!ind) continue;

    const last = arr[arr.length - 1];
    const price = last[4];
    const { dir, bodyPct } = classifyCandle(last[1], last[4], last[2], last[3]);

    const volArr = arr.map(x => x[5]);
    const lastVol = volArr[volArr.length - 1];
    const avgVol = ind.volumeAvg || 1;
    const volRatio = lastVol / avgVol;

    snapshots.push({
      tf,
      rsi: ind.rsi14,
      adx: ind.adx,
      bbPosition: calcBbPosition(price, ind.bbUpper, ind.bbLower),
      ema20Up: price > ind.ema20,
      lastCandleBodyPct: bodyPct,
      lastCandleDir: dir,
      volRatio,
    });
  }

  if (snapshots.length === 0) {
    return {
      symbol, longEntryScore: 50, shortEntryScore: 50,
      suggestion: "neutral", warnings: ["数据不足"],
      analysis: "【入场质量】数据不足,评分中性",
    };
  }

  let longScore = 50;
  const longWarnings: string[] = [];
  let shortScore = 50;
  const shortWarnings: string[] = [];

  for (const s of snapshots) {
    const weight = s.tf === "1d" ? 1.5 : 1.0;

    // RSI
    if (s.rsi >= 75) { longScore -= 15 * weight; longWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}极度超买`); }
    else if (s.rsi >= 65) { longScore -= 8 * weight; longWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}偏高`); }
    else if (s.rsi <= 25) { longScore += 12 * weight; }
    else if (s.rsi <= 35) { longScore += 6 * weight; }

    if (s.rsi <= 20) { shortScore -= 15 * weight; shortWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}极度超卖`); }
    else if (s.rsi <= 30) { shortScore -= 8 * weight; shortWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}超卖`); }
    else if (s.rsi >= 70) { shortScore += 10 * weight; }
    else if (s.rsi >= 60) { shortScore += 5 * weight; }

    // BB
    const bbL = s.bbPosition >= 75 ? "上轨" : s.bbPosition <= 25 ? "下轨" : "中";
    if (s.bbPosition >= 90) {
      longScore -= 12 * weight; longWarnings.push(`${s.tf}BB${bbL}追高`);
      shortScore += 8 * weight;
    } else if (s.bbPosition >= 75) {
      longScore -= 6 * weight; shortScore += 4 * weight;
    } else if (s.bbPosition <= 10) {
      longScore += 8 * weight;
      shortScore -= 12 * weight; shortWarnings.push(`${s.tf}BB${bbL}追空`);
    } else if (s.bbPosition <= 25) {
      longScore += 4 * weight; shortScore -= 6 * weight;
    }

    // EMA
    if (s.ema20Up) { longScore += 3 * weight; shortScore -= 3 * weight; }
    else { longScore -= 3 * weight; shortScore += 3 * weight; }

    // K线实体
    if (s.lastCandleBodyPct > 0.6) {
      if (s.lastCandleDir === "up") shortScore += 4;
      else if (s.lastCandleDir === "down") longScore -= 4;
    }

    // 成交量
    if (s.volRatio > 1.5) {
      if (s.lastCandleDir === "up") longScore += 5;
      else if (s.lastCandleDir === "down") shortScore += 5;
    }
  }

  // 动量衰减：ADX高但方向分化
  const dirs = snapshots.map(s => s.ema20Up);
  const allSame = new Set(dirs).size === 1;
  if (snapshots.filter(s => s.adx >= 40).length >= 2 && !allSame) {
    longScore -= 15; shortScore -= 15;
    longWarnings.push("动量衰减:ADX高但方向分化");
    shortWarnings.push("动量衰减:ADX高但方向分化");
  }

  longScore = Math.max(0, Math.min(100, Math.round(longScore)));
  shortScore = Math.max(0, Math.min(100, Math.round(shortScore)));

  const overallScore = Math.min(longScore, shortScore);
  let suggestion: "favorable" | "neutral" | "unfavorable";
  if (overallScore >= 60) suggestion = "favorable";
  else if (overallScore >= 30) suggestion = "neutral";
  else suggestion = "unfavorable";

  const analysis = [
    `【入场质量】${symbol} 整体:${suggestion}(${overallScore}分)`,
    `  做多:${longScore}分 做空:${shortScore}分`,
  ];
  if (longWarnings.length > 0) analysis.push(`  做多风险: ${longWarnings.slice(0, 3).join(" / ")}`);
  if (shortWarnings.length > 0) analysis.push(`  做空风险: ${shortWarnings.slice(0, 3).join(" / ")}`);

  return {
    symbol,
    longEntryScore: longScore,
    shortEntryScore: shortScore,
    suggestion,
    warnings: [...longWarnings, ...shortWarnings],
    analysis: analysis.join("\n"),
  };
}
