/**
 * ShangAI — TrendAgent (趋势智能体)
 * 移植自 ShangAI 项目，适配 SmartTrade2 基础设施
 *
 * ATR通道突破的趋势跟踪策略 + RSI/ADX/BB/MACD 多重确认
 */
import type { TechnicalIndicators } from "../indicators";
import type { MarketSnapshot, StrategySignal } from "../store/types";
import { interceptParamsCache } from "../state";
import { logger } from "../logger";

export class TrendAgent {
  readonly agentId: string;
  readonly role = "trend" as const;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  analyze(snapshot: MarketSnapshot, indicators: TechnicalIndicators): StrategySignal {
    const { symbol } = snapshot;
    const now = Date.now();

    // 参数（从 intercept_params 数据库读取，可动态调整）
    const fallback = (n: string, d: number) => interceptParamsCache.get(n) ?? d;
    const rsiLower = fallback("trend_rsi_lower", 30);
    const rsiUpper = fallback("trend_rsi_upper", 70);
    const adxMin = fallback("trend_adx_min", 25);
    const chMult = fallback("trend_atr_ch_mult", 150) / 100;
    const bbLower = fallback("trend_bb_lower", 20) / 100;
    const bbUpper = fallback("trend_bb_upper", 80) / 100;

    const adaptiveThreshold = indicators.atrPct * chMult;

    const { high, low, close } = this.extractLatestOHLC(snapshot);
    const atrUpper = close * (1 + adaptiveThreshold / 100);
    const atrLower = close * (1 - adaptiveThreshold / 100);
    const breakoutUp = high > atrUpper;
    const breakoutDown = low < atrLower;

    const rsiOK = indicators.rsi14 > rsiLower && indicators.rsi14 < rsiUpper;
    const rsiOversold = indicators.rsi14 < rsiLower;
    const trendStrong = indicators.adx > adxMin;

    const bbWidth = indicators.bbUpper - indicators.bbLower;
    const bbPosition = bbWidth > 0 ? (close - indicators.bbLower) / bbWidth : 0.5;

    const macdBullish = indicators.macdSignal === "金叉" || indicators.macdSignal === "底背离";
    const macdBearish = indicators.macdSignal === "死叉" || indicators.macdSignal === "顶背离";

    let action: StrategySignal["action"] = "hold";
    let confidence = 0;
    const reasons: string[] = [];

    if (breakoutUp && rsiOK && trendStrong) {
      action = "buy";
      confidence += 40;
      if (macdBullish) { confidence += 25; reasons.push("MACD金叉/底背离确认"); }
      if (bbPosition < bbLower) { confidence += 15; reasons.push("价格位于BB下轨附近"); }
      if (indicators.volumeRatio > 1.2) { confidence += 10; reasons.push("放量突破"); }
    }

    if (breakoutDown && rsiOK && trendStrong) {
      action = "sell";
      confidence += 40;
      if (macdBearish) { confidence += 25; reasons.push("MACD死叉/顶背离确认"); }
      if (bbPosition > bbUpper) { confidence += 15; reasons.push("价格位于BB上轨附近"); }
      if (indicators.volumeRatio > 1.2) { confidence += 10; reasons.push("放量下跌"); }
    }

    if (action === "hold" && rsiOversold && macdBullish && bbPosition < bbLower * 0.5) {
      action = "buy";
      confidence += 30;
      reasons.push("RSI超卖+MACD底背离+BB下轨，超跌反弹");
    }

    if (action === "hold" && indicators.rsi14 > rsiUpper && macdBearish && bbPosition > bbUpper * 1.1) {
      action = "sell";
      confidence += 30;
      reasons.push("RSI超买+MACD顶背离+BB上轨，超涨回落");
    }

    // --- 深度加成：RSI极端+BB极轨+量比，区分信号强弱 ---
    if (action !== "hold") {
      const depth: string[] = [];
      const isBuy = action === "buy";
      if (isBuy && indicators.rsi14 < 25) { confidence += 15; depth.push(`RSI${indicators.rsi14.toFixed(0)}极度超卖`); }
      else if (isBuy && indicators.rsi14 < 30) { confidence += 10; depth.push(`RSI${indicators.rsi14.toFixed(0)}超卖`); }
      else if (!isBuy && indicators.rsi14 > 75) { confidence += 15; depth.push(`RSI${indicators.rsi14.toFixed(0)}极度超买`); }
      else if (!isBuy && indicators.rsi14 > 70) { confidence += 10; depth.push(`RSI${indicators.rsi14.toFixed(0)}超买`); }
      const bbDist = isBuy ? bbPosition : 1 - bbPosition;
      if (bbDist < 0.1) { confidence += 15; depth.push("BB触轨"); }
      else if (bbDist < 0.2) { confidence += 8; depth.push("BB近轨"); }
      if (indicators.volumeRatio > 2.0) { confidence += 15; depth.push(`量${indicators.volumeRatio.toFixed(1)}×巨量`); }
      else if (indicators.volumeRatio > 1.5) { confidence += 8; depth.push(`量${indicators.volumeRatio.toFixed(1)}×放量`); }
      if (indicators.atrPct > 1.5) { confidence += 5; depth.push(`ATR${indicators.atrPct.toFixed(1)}%高波动`); }
      if (depth.length > 0) reasons.push(depth.join("+"));
    }

    if (action === "hold" && indicators.adx > 50) {
      const emaUp = indicators.ema20 > indicators.ema50;
      const rsiMid = indicators.rsi14 > 30 && indicators.rsi14 < 70;
      if (rsiMid) {
        if (emaUp) {
          action = "buy"; confidence = 40;
          if (macdBullish) { confidence += 20; reasons.push("MACD金叉确认"); }
          if (bbPosition < bbLower) { confidence += 10; reasons.push("BB下轨附近"); }
          if (indicators.volumeRatio > 1.2) { confidence += 10; reasons.push("放量"); }
          reasons.push(`ADX${indicators.adx.toFixed(0)}强趋势追多`);
        } else {
          action = "sell"; confidence = 40;
          if (macdBearish) { confidence += 20; reasons.push("MACD死叉确认"); }
          if (bbPosition > bbUpper) { confidence += 10; reasons.push("BB上轨附近"); }
          if (indicators.volumeRatio > 1.2) { confidence += 10; reasons.push("放量"); }
          reasons.push(`ADX${indicators.adx.toFixed(0)}强趋势追空`);
        }
      }
    }

    confidence = Math.min(confidence, 100);
    if (action === "hold") reasons.push("无明确入场信号");
    reasons.push(`ATR通道: [${atrLower.toFixed(4)}, ${atrUpper.toFixed(4)}] (±${adaptiveThreshold.toFixed(2)}%)`);

    return {
      agentId: this.agentId,
      agentRole: this.role,
      symbol,
      action,
      confidence,
      reason: reasons.join("; "),
      indicators: indicators as any,
      suggestedLeverage: this.suggestLeverage(indicators),
      suggestedAmountPct: this.suggestAmount(confidence),
      timestamp: now,
    };
  }

  private extractLatestOHLC(snapshot: MarketSnapshot): { high: number; low: number; close: number } {
    const h1h = snapshot.highs_1h;
    const h1l = snapshot.lows_1h;
    const h1c = snapshot.closes_1h;
    if (h1h && h1h.length > 0) {
      return { high: h1h[h1h.length - 1], low: h1l[h1l.length - 1], close: h1c[h1c.length - 1] };
    }
    return { high: snapshot.high24h, low: snapshot.low24h, close: snapshot.price };
  }

  private suggestLeverage(ind: TechnicalIndicators): number {
    if (ind.atrPct > 5) return 1;
    if (ind.atrPct > 3) return 2;
    return 3;
  }

  private suggestAmount(confidence: number): number {
    if (confidence >= 80) return 8;
    if (confidence >= 60) return 5;
    return 3;
  }
}
