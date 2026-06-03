/**
 * 策略1: 多周期技术面分析
 * 输入: 多时间框架 OHLCV, 回测结果
 * 输出: 趋势方向 + 共振/背离分析 + 置信度
 */
import { calcIndicators, calcMACD, convertCandles, type Indicators } from "../indicators";
import type { BacktestResult } from "../backtest";

export interface TechnicalAnalysis {
  symbol: string;
  directionBias: "bullish" | "bearish" | "neutral";
  confidence: number;
  analysis: string;
  alignmentScore: number;
}

interface TfSnapshot {
  tf: string;
  chg: number;
  adx: number; rsi: number; atr: number;
  ema20Up: boolean; ema50Up: boolean;
  bbPosition: number;
  volRatio: number;
  macdSignal: string;
}

function adxLabel(adx: number): string {
  if (adx >= 75) return `极强(ADX${adx.toFixed(0)})`;
  if (adx >= 50) return `强(ADX${adx.toFixed(0)})`;
  if (adx >= 40) return `明确(ADX${adx.toFixed(0)})`;
  if (adx >= 25) return `弱(ADX${adx.toFixed(0)})`;
  if (adx >= 18) return `震荡(ADX${adx.toFixed(0)})`;
  return `纯震荡(ADX${adx.toFixed(0)})`;
}

function rsiLabel(rsi: number): string {
  if (rsi >= 75) return `极度超买`;
  if (rsi >= 70) return `超买`;
  if (rsi <= 25) return `极度超卖`;
  if (rsi <= 30) return `超卖`;
  return `正常`;
}

function bbLabel(position: number): string {
  if (position >= 90) return "BB上轨";
  if (position >= 75) return "BB上沿";
  if (position <= 10) return "BB下轨";
  if (position <= 25) return "BB下沿";
  return "BB中";
}

function macdLabel(signal: string): string {
  if (signal.includes("顶背离")) return "MACD顶背离";
  if (signal.includes("底背离")) return "MACD底背离";
  if (signal === "金叉") return "MACD金叉";
  if (signal === "死叉") return "MACD死叉";
  return signal;
}

/**
 * 多周期技术面分析
 * @param ohlcv 多时间框架 K 线数据
 * @param backtest 回测结果
 * @param symbol 币种
 */
export function analyzeTechnicals(
  ohlcv: Record<string, any[]>,
  backtest: BacktestResult | null,
  symbol: string,
): TechnicalAnalysis {
  const snapshots: TfSnapshot[] = [];

  for (const tf of ["1m", "5m", "15m", "1h", "1d"]) {
    const raw = ohlcv[tf];
    if (!raw || raw.length < 8) continue;
    const arr = convertCandles(raw);
    const ind = calcIndicators(arr);
    if (!ind) continue;

    const price = arr[arr.length - 1][4];
    const openFirst = arr[0][4];
    const chg = ((price - openFirst) / openFirst) * 100;

    const volArr = arr.map(x => x[5]);
    const lastVol = volArr[volArr.length - 1];
    const avgVol = ind.volumeAvg || 1;
    const volRatio = lastVol / avgVol;

    const bbPos = ind.bbUpper > ind.bbLower
      ? ((price - ind.bbLower) / (ind.bbUpper - ind.bbLower)) * 100
      : 50;

    let macdSig = "";
    if (tf === "1h" || tf === "1d") {
      const closes = arr.map(x => x[4]);
      const m = calcMACD(closes);
      if (m.signal !== "数据不足") macdSig = m.signal;
    }

    snapshots.push({
      tf, chg,
      adx: ind.adx, rsi: ind.rsi14,
      atr: (ind.atr14 / price) * 100,
      ema20Up: price > ind.ema20,
      ema50Up: price > ind.ema50,
      bbPosition: bbPos,
      volRatio,
      macdSignal: macdSig,
    });
  }

  if (snapshots.length < 3) {
    return { symbol, directionBias: "neutral", confidence: 20, analysis: "数据不足", alignmentScore: 0 };
  }

  // === 方向计算 ===
  const h1 = snapshots.find(s => s.tf === "1h");
  const d1 = snapshots.find(s => s.tf === "1d");

  let dirScore = 0;
  const evidence: string[] = [];

  if (d1 && d1.adx >= 18) {
    const dUp = d1.ema20Up;
    const dWeight = d1.adx >= 40 ? 3 : d1.adx >= 25 ? 2 : 1;
    dirScore += dUp ? dWeight : -dWeight;
    evidence.push(`日线${d1.chg >= 0 ? "+" : ""}${d1.chg.toFixed(1)}% ${adxLabel(d1.adx)} EMA20${dUp ? "↑" : "↓"}`);
  }
  if (h1) {
    const hUp = h1.ema20Up;
    const hWeight = h1.adx >= 40 ? 2 : h1.adx >= 25 ? 1 : 0.5;
    dirScore += hUp ? hWeight : -hWeight;
    evidence.push(`1h${h1.chg >= 0 ? "+" : ""}${h1.chg.toFixed(1)}% ${adxLabel(h1.adx)} EMA20${hUp ? "↑" : "↓"}`);
  }

  // 多周期一致性
  const ema20Dirs = snapshots.map(s => s.ema20Up);
  const sameCount = ema20Dirs.filter(d => true).length;
  const upCount = ema20Dirs.filter(d => d).length;
  const majority = upCount >= ema20Dirs.length / 2;
  const allSame = upCount === ema20Dirs.length || upCount === 0;
  const alignmentScore = allSame ? 100 : Math.round((Math.max(upCount, ema20Dirs.length - upCount) / ema20Dirs.length) * 100);

  if (allSame) {
    evidence.push(`全周期共振(${upCount > 0 ? "多" : "空"})`);
  } else if (alignmentScore >= 60) {
    evidence.push(`多数共振${upCount > ema20Dirs.length / 2 ? "偏多" : "偏空"}(${alignmentScore}%)`);
  } else {
    evidence.push(`周期矛盾(${alignmentScore}%)`);
  }

  // 回测
  if (backtest) {
    evidence.push(`回测:${backtest.optimalStrategy} cf${backtest.confidence}% 反${backtest.revAccuracy.toFixed(0)}% vs 续${backtest.contAccuracy.toFixed(0)}%`);
  }

  // RSI/BB/MACD 警告
  const warnings: string[] = [];
  for (const s of snapshots) {
    const rs = rsiLabel(s.rsi);
    if (rs !== "正常") warnings.push(`${s.tf}RSI${s.rsi.toFixed(0)}:${rs}`);
    const bb = bbLabel(s.bbPosition);
    if (bb.includes("轨")) warnings.push(`${s.tf}:${bb}`);
    if (s.macdSignal.includes("背离")) warnings.push(`${s.tf}:${macdLabel(s.macdSignal)}`);
  }

  // 成交量
  const volLines: string[] = [];
  for (const s of snapshots) {
    if (s.tf === "1h" || s.tf === "1d") {
      volLines.push(`${s.tf}量${s.volRatio.toFixed(1)}×`);
    }
  }

  // 方向定性
  let directionBias: "bullish" | "bearish" | "neutral";
  if (Math.abs(dirScore) >= 3) {
    directionBias = dirScore > 0 ? "bullish" : "bearish";
  } else {
    directionBias = "neutral";
  }

  // 置信度
  let conf = alignmentScore * 0.4;
  const maxAdx = Math.max(h1?.adx ?? 0, d1?.adx ?? 0);
  if (maxAdx >= 50) conf += 15;
  else if (maxAdx >= 40) conf += 8;
  if (backtest && backtest.confidence >= 70) conf += 10;
  const extremeCount = warnings.length;
  if (extremeCount >= 3) conf -= 20;
  else if (extremeCount >= 1) conf -= 8;
  if (snapshots.some(s => s.volRatio < 0.6)) conf -= 8;
  if (directionBias === "neutral") conf -= 15;

  const confidence = Math.max(10, Math.min(95, Math.round(conf)));

  // 分析文本
  const tfLines = snapshots.map(s => {
    const parts = [
      `ADX${s.adx.toFixed(0)}`,
      `RSI${s.rsi.toFixed(0)}(${rsiLabel(s.rsi)})`,
      `ATR${s.atr.toFixed(1)}%`,
      `EMA20${s.ema20Up ? "↑" : "↓"}`,
      s.tf === "1d" ? `EMA50${s.ema50Up ? "↑" : "↓"}` : "",
      `BB${Math.round(s.bbPosition)}%`,
      s.macdSignal ? macdLabel(s.macdSignal) : "",
    ].filter(Boolean);
    return `  ${s.tf}: ${s.chg >= 0 ? "+" : ""}${s.chg.toFixed(1)}% ${parts.join(" ")}`;
  });

  const analysis = [
    `【技术面】${symbol} 方向:${directionBias} 置信:${confidence}% 共识:${alignmentScore}%`,
    ...tfLines,
    `证据: ${evidence.join(" | ")}`,
    volLines.length ? `成交: ${volLines.join(" ")}` : "",
    warnings.length ? `风险: ${warnings.join(" | ")}` : "",
  ].filter(Boolean).join("\n");

  return { symbol, directionBias, confidence, analysis, alignmentScore };
}
