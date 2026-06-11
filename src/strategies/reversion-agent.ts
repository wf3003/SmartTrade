/**
 * MeanReversionAgent — 均值回归智能体
 * 适用行情：CI > 62 / ADX < 18 的震荡市场
 * 
 * RSI<25+BB下轨 → 做多；RSI>75+BB上轨 → 做空
 */
import type { TechnicalIndicators } from "../indicators";
import type { MarketSnapshot, StrategySignal } from "../store/types";
import { interceptParamsCache } from "../state";

export class MeanReversionAgent {
  readonly agentId: string;
  readonly role = "reversion" as const;
  constructor(agentId: string) { this.agentId = agentId; }

  analyze(snapshot: MarketSnapshot, indicators: TechnicalIndicators): StrategySignal {
    const fb = (n: string, d: number) => interceptParamsCache.get(n) ?? d;
    const rsiLow = fb("rev_rsi_oversold", 25);
    const rsiHigh = fb("rev_rsi_overbought", 75);
    const bDist = fb("rev_bb_distance", 10) / 100;

    const bbW = indicators.bbUpper - indicators.bbLower;
    const bbP = bbW > 0 ? (snapshot.price - indicators.bbLower) / bbW : 0.5;
    const rsi = indicators.rsi14;
    let action: StrategySignal["action"] = "hold";
    let conf = 0;
    const r: string[] = [];

    if (rsi < rsiLow && bbP < bDist) {
      action = "buy"; conf = Math.min(80, Math.round((rsiLow - rsi) / rsiLow * 50 + 30));
      r.push(`RSI${rsi.toFixed(0)}超卖+BB下轨`);
    }
    if (rsi > rsiHigh && bbP > 1 - bDist) {
      const sc = Math.min(80, Math.round((rsi - rsiHigh) / (100 - rsiHigh) * 50 + 30));
      if (sc > conf) { action = "sell"; conf = sc; r.length = 0; r.push(`RSI${rsi.toFixed(0)}超买+BB上轨`); }
    }
    if (action === "hold") r.push("无极端RSI+BB位置");

    return {
      agentId: this.agentId, agentRole: this.role, symbol: snapshot.symbol,
      action, confidence: Math.min(conf, 100), reason: r.join("; "),
      indicators: indicators as any, suggestedLeverage: 2,
      suggestedAmountPct: Math.min(5, Math.round(conf / 20)),
      timestamp: Date.now(),
    };
  }
}
