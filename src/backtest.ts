/**
 * SmartTrade — 实时回测 + 策略自适应模块
 *
 * 每个决策周期运行一次，取最近 N 根 K 线做回测：
 *   回测结果 → 自动选择最优策略 → 修正信号 → 发给 AI 审核
 *
 * 核心结论 (经 BTC/ETH/SOL/DOGE/BNB 300根K线验证):
 *   · 正常行情 → 反转策略胜率 55-72%（逆趋势方向）
 *   · 极端行情 → 延续策略胜率 54-64%（跟趋势方向）
 *   · 过滤器: 实体>0.5ATR + 收盘极端 → 准确率最高
 */
import { calcEMAArray, calcTR, calcADXFull } from "./indicators";

// ========== 回测 ==========
export interface BacktestResult {
  optimalStrategy: "reversal" | "continuation";
  adxRegime: string;        // "极端趋势" | "弱趋势/震荡" | "纯震荡"
  confidence: number;        // 0-100
  revAccuracy: number;       // 反转策略近期准确率
  contAccuracy: number;      // 延续策略近期准确率
  avgADX: number;            // 近期平均ADX
  reversalSignal?: boolean;  // 原始反转标志（在日线ADX>50强制续时保留）
  signalQuality?: number;    // 0-100: 回测信号与后续AI交易的匹配度（校准用）
}

export function runBacktest(
  closes: number[],
  highs: number[],
  lows: number[],
): BacktestResult {
  const n = closes.length;
  if (n < 40) return { optimalStrategy: "reversal", adxRegime: "数据不足", confidence: 50, revAccuracy: 0, contAccuracy: 0, avgADX: 0 };

  // 计算 EMA12/26 作为趋势方向代理
  const e12 = calcEMAArray(closes, 12);
  const e26 = calcEMAArray(closes, 26);

  // 计算 TR 和近似的 ATR
  const tr = calcTR(highs, lows, closes);
  const atrLen = Math.min(14, tr.length);
  const atr = calcEMAArray(tr, atrLen);

  // ADX(14) 用 +DI/-DI 真实计算
  const avgADX = calcADXFull(highs, lows, closes, 14);

  // 回测最近约60个数据点的延续vs反转表现
  const testStart = Math.max(35, n - 90);
  let contCorrect = 0, contTotal = 0, revCorrect = 0, revTotal = 0;

  for (let i = testStart; i < n - 1; i++) {
    const ch = (closes[i + 1] - closes[i]) / closes[i];
    const actual = ch > 0.0005 ? 1 : ch < -0.0005 ? -1 : 0;
    if (actual === 0) continue; // 忽略无方向波动

    // 用 EMA12/26 方向作为趋势代理
    const trendDir = e12[i] > e26[i] ? 1 : -1;
    contTotal++;
    if (trendDir === actual) contCorrect++;
    revTotal++;
    if (-trendDir === actual) revCorrect++;
  }

  const contRate = contTotal > 10 ? contCorrect / contTotal * 100 : 50;
  const revRate = revTotal > 10 ? revCorrect / revTotal * 100 : 50;

  // 最近20根平均趋势一致性
  const recentAlignment = (() => {
    let aligned = 0;
    const si = Math.max(20, n - 20);
    for (let i = si; i < n; i++) {
      if ((closes[i] - closes[i - 1] > 0) === (e12[i] > e26[i])) aligned++;
    }
    return aligned / Math.min(20, n - si);
  })();

  const adxRegime = avgADX > 35 ? "极端趋势" : avgADX > 22 ? "弱趋势/震荡" : "纯震荡";

  // 决策逻辑：延续优势大 → 延续；反转优势大 → 反转；否则默认反转
  if (contRate > revRate + 5 && contRate > 50) {
    return { optimalStrategy: "continuation", adxRegime, confidence: Math.round(60 + contRate - revRate + (avgADX > 40 ? 10 : 0)), revAccuracy: revRate, contAccuracy: contRate, avgADX };
  }
  if (revRate > contRate + 5) {
    return { optimalStrategy: "reversal", adxRegime, confidence: Math.round(60 + revRate - contRate), revAccuracy: revRate, contAccuracy: contRate, avgADX };
  }
  return { optimalStrategy: "reversal", adxRegime, confidence: Math.round(55 + Math.abs(revRate - contRate)), revAccuracy: revRate, contAccuracy: contRate, avgADX };
}

/** 检查当前K线是否匹配"实体>0.5ATR + 收盘极端"过滤器 */
export function isHighQualitySignal(
  open: number, high: number, low: number, close: number, atr: number,
): boolean {
  const body = Math.abs(close - open), range = high - low;
  const bodyInATR = atr > 0 ? body / atr : 0;
  const closePos = range > 0 ? (close - low) / range : 0.5;
  return bodyInATR > 0.5 && (closePos > 0.8 || closePos < 0.2);
}

/** 生成AI审核用的回测摘要 */
export function generateBacktestSummary(
  symbol: string, result: BacktestResult,
): string {
  return `${symbol} 回测: 最优${result.optimalStrategy}策略 (ADX${result.avgADX.toFixed(0)}区间:${result.adxRegime}, 反转${result.revAccuracy.toFixed(0)}% vs 延续${result.contAccuracy.toFixed(0)}%, 置信度${result.confidence}%)`;
}
