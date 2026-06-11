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
import { interceptParamsCache } from "../state";

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

  const eq = (n: string, f: number) => interceptParamsCache.get(n) ?? f;
  let longScore = 50;
  const longWarnings: string[] = [];
  let shortScore = 50;
  const shortWarnings: string[] = [];

  for (const s of snapshots) {
    const w = s.tf === "1d" ? eq("eq_tf_daily_weight", 150) / 100 : 1.0;

    // RSI
    if (s.rsi >= 75) { longScore -= eq("eq_rsi_extreme_ob_p", 15) * w; longWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}极度超买`); }
    else if (s.rsi >= 65) { longScore -= eq("eq_rsi_mild_ob_p", 8) * w; longWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}偏高`); }
    else if (s.rsi <= 25) { longScore += eq("eq_rsi_extreme_os_lb", 12) * w; }
    else if (s.rsi <= 35) { longScore += eq("eq_rsi_mild_os_lb", 6) * w; }

    if (s.rsi <= 20) { shortScore -= eq("eq_rsi_extreme_os_sp", 15) * w; shortWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}极度超卖`); }
    else if (s.rsi <= 30) { shortScore -= eq("eq_rsi_mild_os_sp", 8) * w; shortWarnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}超卖`); }
    else if (s.rsi >= 70) { shortScore += eq("eq_rsi_ob_sb", 10) * w; }
    else if (s.rsi >= 60) { shortScore += eq("eq_rsi_mild_ob_sb", 5) * w; }

    // BB
    const bbL = s.bbPosition >= 75 ? "上轨" : s.bbPosition <= 25 ? "下轨" : "中";
    if (s.bbPosition >= 90) {
      longScore -= eq("eq_bb_extreme_ob_lp", 12) * w; longWarnings.push(`${s.tf}BB${bbL}追高`);
      shortScore += eq("eq_bb_extreme_ob_sb", 8) * w;
    } else if (s.bbPosition >= 75) {
      longScore -= eq("eq_bb_mild_ob_lp", 6) * w; shortScore += eq("eq_bb_mild_ob_sb", 4) * w;
    } else if (s.bbPosition <= 10) {
      longScore += eq("eq_bb_extreme_os_lb", 8) * w;
      shortScore -= eq("eq_bb_extreme_os_sp", 12) * w; shortWarnings.push(`${s.tf}BB${bbL}追空`);
    } else if (s.bbPosition <= 25) {
      longScore += eq("eq_bb_mild_os_lb", 4) * w; shortScore -= eq("eq_bb_mild_os_sp", 6) * w;
    }

    // EMA
    if (s.ema20Up) { longScore += eq("eq_ema_up_lb", 3) * w; shortScore -= eq("eq_ema_up_sp", 3) * w; }
    else { longScore -= eq("eq_ema_up_lb", 3) * w; shortScore += eq("eq_ema_up_sp", 3) * w; }

    // K线实体
    if (s.lastCandleBodyPct > 0.6) {
      if (s.lastCandleDir === "up") shortScore += eq("eq_body_big_bull_sb", 4);
      else if (s.lastCandleDir === "down") longScore -= eq("eq_body_big_bear_lp", 4);
    }

    // 成交量
    if (s.volRatio > 1.5) {
      if (s.lastCandleDir === "up") longScore += eq("eq_vol_surge_bull_lb", 5);
      else if (s.lastCandleDir === "down") shortScore += eq("eq_vol_surge_bear_sb", 5);
    }
  }

  // 动量衰减
  const dirs = snapshots.map(s => s.ema20Up);
  const allSame = new Set(dirs).size === 1;
  if (snapshots.filter(s => s.adx >= 40).length >= 2 && !allSame) {
    const decay = eq("eq_momentum_decay_p", 15);
    longScore -= decay; shortScore -= decay;
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
