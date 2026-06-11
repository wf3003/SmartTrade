/**
 * ShangAI — Coordinator (协调器)
 * 移植自 ShangAI 项目，适配 SmartTrade2
 *
 * 接收多智能体信号，凯利公式分配风险预算，冲突互锁
 */
import type { StrategySignal, TradeDecision } from "../store/types";

/** 协调器内部信号条目 */
interface WeightedSignal {
  signal: StrategySignal;
  kellyWeight: number;
  dynamicWinRate: number;
}

export class Coordinator {
  private kellySafetyFactor: number;
  private maxSinglePositionPct: number;
  private maxTotalExposurePct: number;
  private signalHistory: { symbol: string; action: string; correct: boolean }[] = [];

  constructor(options?: {
    kellySafetyFactor?: number;
    maxSinglePositionPct?: number;
    maxTotalExposurePct?: number;
  }) {
    this.kellySafetyFactor = options?.kellySafetyFactor ?? 4;
    this.maxSinglePositionPct = options?.maxSinglePositionPct ?? 10;
    this.maxTotalExposurePct = options?.maxTotalExposurePct ?? 50;
  }

  async evaluate(signals: StrategySignal[]): Promise<TradeDecision[]> {
    if (signals.length === 0) return [];

    const actionable = signals.filter(s => s.action !== "hold");
    if (actionable.length === 0) return [];

    const bySymbol = new Map<string, StrategySignal[]>();
    for (const s of actionable) {
      const list = bySymbol.get(s.symbol) || [];
      list.push(s);
      bySymbol.set(s.symbol, list);
    }

    const resolved: WeightedSignal[] = [];

    for (const [symbol, sigs] of bySymbol) {
      const buys = sigs.filter(s => s.action === "buy");
      const sells = sigs.filter(s => s.action === "sell");

      if (buys.length > 0 && sells.length > 0) {
        const netConfidence = this.netConfidence(buys, sells);
        if (netConfidence.net === "buy") {
          resolved.push(...buys.map(s => this.toWeighted(s)));
        } else if (netConfidence.net === "sell") {
          resolved.push(...sells.map(s => this.toWeighted(s)));
        }
      } else if (buys.length > 0) {
        resolved.push(...buys.map(s => this.toWeighted(s)));
      } else if (sells.length > 0) {
        resolved.push(...sells.map(s => this.toWeighted(s)));
      }
    }

    if (resolved.length === 0) return [];

    const totalKelly = resolved.reduce((sum, ws) => sum + ws.kellyWeight, 0);

    const decisions: TradeDecision[] = [];

    for (const ws of resolved) {
      const { signal, kellyWeight } = ws;
      const allocationPct = totalKelly > 0
        ? (kellyWeight / totalKelly) * this.maxTotalExposurePct
        : 0;

      const adjustedAmount = Math.min(
        signal.suggestedAmountPct,
        allocationPct,
        this.maxSinglePositionPct,
      );

      const adjustedLeverage = signal.suggestedLeverage > 0 ? signal.suggestedLeverage : 2;

      decisions.push({
        signal,
        riskApproved: adjustedAmount > 0,
        adjustedLeverage,
        adjustedAmountPct: adjustedAmount,
      });
    }

    return decisions;
  }

  recordOutcome(symbol: string, action: string, correct: boolean): void {
    this.signalHistory.push({ symbol, action, correct });
    if (this.signalHistory.length > 200) {
      this.signalHistory = this.signalHistory.slice(-200);
    }
  }

  getDynamicWinRate(): number {
    if (this.signalHistory.length < 10) return 0.55;
    const correct = this.signalHistory.filter(r => r.correct).length;
    return correct / this.signalHistory.length;
  }

  private toWeighted(signal: StrategySignal): WeightedSignal {
    const p = this.getDynamicWinRate();
    const b = this.estimateRR(signal);
    const kellyWeight = this.kellyFormula(p, b);
    return { signal, kellyWeight, dynamicWinRate: p };
  }

  private kellyFormula(p: number, b: number): number {
    if (b <= 0) return 0;
    const raw = (p * (b + 1) - 1) / b;
    if (raw <= 0) return 0;
    return raw / this.kellySafetyFactor;
  }

  private estimateRR(signal: StrategySignal): number {
    if (signal.confidence >= 80) return 3.0;
    if (signal.confidence >= 60) return 2.0;
    return 1.5;
  }

  private netConfidence(
    buys: StrategySignal[],
    sells: StrategySignal[],
  ): { net: "buy" | "sell" | "neutral" } {
    const buyWeight = buys.reduce((s, sig) => s + sig.confidence, 0);
    const sellWeight = sells.reduce((s, sig) => s + sig.confidence, 0);

    const ratio = buyWeight / (sellWeight || 1);
    if (ratio > 1.5) return { net: "buy" };
    if (ratio < 1 / 1.5) return { net: "sell" };
    return { net: "neutral" };
  }
}
