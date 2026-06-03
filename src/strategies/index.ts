/**
 * 策略编排器 — 收集三个独立策略的输出, 组装为统一上下文
 *
 * 策略1: 技术面分析 (multi-tf indicators, 趋势方向, 共振/背离)
 * 策略2: 资金面/情绪分析 (费率拥挤, 成交量, 市场质量)
 * 策略3: 风控/风险回报评估 (ATR波动, 仓位, 止损止盈)
 *
 * 产品 → AI 投资委员会主席 做最终决策
 */
import type { MarketData, Position, AccountInfo } from "../exchanges";
import { runBacktest, generateBacktestSummary, type BacktestResult } from "../backtest";
import { calcIndicators, convertCandles } from "../indicators";
import { analyzeTechnicals, type TechnicalAnalysis } from "./technical";
import { analyzeSentiment, type SentimentAnalysis } from "./sentiment";
import { assessSymbolRisk, assessPortfolioRisk, type RiskAssessment, type PortfolioRisk } from "./risk-reward";
import { assessEntryQuality, type EntryQuality } from "./entry-quality";
import { CONFIG } from "../config";
import { setAtrCache, setRsiCache } from "../state";
import { logger } from "../logger";

export interface StrategyOutput {
  symbol: string;
  technical: TechnicalAnalysis;
  sentiment: SentimentAnalysis;
  risk: RiskAssessment;
  /** 结果4: 入场质量 */
  entryQuality: EntryQuality;
  backtest: BacktestResult | null;
  backtestSummary: string;
}

export interface StrategyReport {
  /** 每个币种的完整策略分析 */
  analyses: StrategyOutput[];
  /** 组合级别风控 */
  portfolioRisk: PortfolioRisk;
  /** 汇总文本(用于前端展示) */
  summary: string;
  /** AI prompt 用的完整上下文 */
  aiPromptContext: string;
}

/**
 * 运行全部策略, 输出编排结果
 */
export function runStrategyEngine(
  tickers: Map<string, MarketData>,
  ohlcvData: Map<string, Record<string, any[]>>,
  positions: Position[],
  account: AccountInfo,
): StrategyReport {
  const analyses: StrategyOutput[] = [];
  const existingSymbols = new Set(positions.map(p => p.symbol));

  for (const sym of CONFIG.symbols) {
    const ticker = tickers.get(sym);
    const ohlcv = ohlcvData.get(sym);
    if (!ticker || !ohlcv) {
      logger.warn(`[策略引擎] ${sym} 数据不足,跳过`);
      continue;
    }

    // === 回测(先跑, 给其他策略参考) ===
    let backtest: BacktestResult | null = null;
    let backtestSummary = "";
    try {
      const c1h = ohlcv["1h"] ? convertCandles(ohlcv["1h"]) : [];
      if (c1h.length >= 40) {
        const closes = c1h.map(x => x[4]);
        const highs = c1h.map(x => x[2]);
        const lows = c1h.map(x => x[3]);
        backtest = runBacktest(closes, highs, lows);
        backtestSummary = generateBacktestSummary(sym, backtest);
      }
    } catch (e: any) {
      logger.warn(`[策略引擎] ${sym} 回测失败: ${e.message}`);
    }

    // === 策略1: 技术面 ===
    const technical = analyzeTechnicals(ohlcv, backtest, sym);

    // === 策略2: 资金面 ===
    const sentiment = analyzeSentiment(ticker, ohlcv, sym);

    // === 获取 ATR/RSI 缓存值 ===
    const c1h = ohlcv["1h"] ? convertCandles(ohlcv["1h"]) : [];
    const ind = calcIndicators(c1h);
    const atrPct = ind ? (ind.atr14 / ticker.price * 100) : 2;
    const rsi = ind ? Math.round(ind.rsi14) : 50;

    // 缓存到全局状态(供监控循环用)
    setAtrCache(sym, atrPct);
    setRsiCache(sym, rsi);

    // === 策略3: 风控 ===
    const existingPos = positions.find(p => p.symbol === sym);
    const risk = assessSymbolRisk(sym, technical, sentiment, atrPct, existingPos);

    // === 策略4: 入场质量 ===
    const entryQuality = assessEntryQuality(ohlcv, sym);

    analyses.push({
      symbol: sym,
      technical,
      sentiment,
      risk,
      entryQuality,
      backtest,
      backtestSummary,
    });
  }

  // === 组合风控 ===
  const portfolioRisk = assessPortfolioRisk(account, positions);

  // === 汇总 ===
  const summary = `【策略引擎】${analyses.length}币种 | 组合风险:${portfolioRisk.riskLevel} | 敞口:${portfolioRisk.totalExposurePct.toFixed(1)}% | ${portfolioRisk.atPositionLimit ? "已达上限" : "可开新仓"}`;

  // === 构建 AI prompt 上下文 ===
  const promptParts: string[] = [];

  promptParts.push("## 策略分析报告\n");
  promptParts.push("以下是三个独立策略对每个币种的专项分析。你作为投资委员会主席，需要综合这些分析做出最终决策。\n");

  for (const a of analyses) {
    promptParts.push(`\n### ${a.symbol}`);
    promptParts.push(a.technical.analysis);
    promptParts.push(a.sentiment.analysis);
    promptParts.push(a.risk.analysis);
    promptParts.push(a.entryQuality.analysis);
    if (a.backtestSummary) {
      promptParts.push(`回测: ${a.backtestSummary}`);
    }

    // 同向/矛盾提示
    if (
      a.technical.directionBias !== "neutral" &&
      a.sentiment.sentimentBias !== "neutral"
    ) {
      if (a.technical.directionBias === a.sentiment.sentimentBias) {
        promptParts.push(`✓ 技术面与资金面同向(${a.technical.directionBias}),信号可靠`);
      } else {
        promptParts.push(`✗ 技术面(${a.technical.directionBias})与资金面(${a.sentiment.sentimentBias})矛盾,需谨慎`);
      }
    }
  }

  promptParts.push(`\n${portfolioRisk.analysis}`);
  promptParts.push(`\n## 入场质量硬规则（必须遵守）`);
  promptParts.push(`入场质量评分仅用于评估"现在是否适合开新仓"，与已有持仓的平仓决策无关：`);
  promptParts.push(`- 入场质量做多评分 < 20 → 不开多头新仓（做多时机差,追高风险大）`);
  promptParts.push(`- 入场质量做空评分 < 20 → 不开空头新仓（做空时机差,追空风险大）`);
  promptParts.push(`- 入场质量整体 suggestion 为 unfavorable → 当前周期不开任何新仓`);
  promptParts.push(`- 已有持仓的平仓决策基于：风控状态、盈亏保护、趋势变化、入场理由是否失效`);
  promptParts.push(`- 注意：你只能对"当前持仓"列表中有的币种输出close指令。没有持仓的币种即使超卖严重也不输出close。`);
  promptParts.push(`\n【策略引擎评估摘要】${summary}`);

  const aiPromptContext = promptParts.join("\n");

  return { analyses, portfolioRisk, summary, aiPromptContext };
}
