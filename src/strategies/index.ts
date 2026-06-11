/**
 * ShangAI 策略引擎 — 移植到 SmartTrade2
 *
 * 使用 TrendAgent + Coordinator 取代旧的四个子策略。
 * 输出格式兼容 SmartTrade2 的 AI 决策管道 (agent.ts / index.ts)
 */
import type { MarketData, Position, AccountInfo } from "../exchanges";
import { calcTechnicalFromOhlcv, calcTechnicalIndicators, calcIndicators, calcMarketQuality, calcChoppinessIndex, calcMACD, convertCandles } from "../indicators";
import type { TechnicalIndicators } from "../indicators";
import { TrendAgent } from "./trend-agent";
import { MeanReversionAgent } from "./reversion-agent";
import { Coordinator } from "./coordinator";
import type { MarketSnapshot, StrategySignal, TradeDecision, NewStrategyReport, SymbolAnalysis } from "../store/types";
import { CONFIG } from "../config";
import { setAtrCache, setRsiCache, setIndicatorCache, interceptParamsCache } from "../state";
import { logger } from "../logger";

/** 多周期快照 — 供 AI prompt 和 supplemental detail 使用 */
export interface TfSnapshot {
  tf: string;
  chg: number;
  adx: number;
  rsi: number;
  atrPct: number;
  ema20Up: boolean;
  bbPosition: number;
  volRatio: number;
  macdSignal: string;
}

/** 旧接口兼容 — 被 index.ts 消费（marketQuality, entryQuality 字段） */
export interface CompatibilityAnalysis {
  symbol: string;
  sentiment: { marketQuality: number };
  entryQuality: { longEntryScore: number; shortEntryScore: number };
  technical: { directionBias: string; snapshots?: TfSnapshot[] };
  backtestSummary: string;
  trendSignal?: import("../store/types").StrategySignal;
}

export interface DirectTradeSignal {
  action: "buy" | "sell" | "hold";
  symbol: string;
  direction: "bullish" | "bearish" | "neutral";
  confidence: number;
  riskFlag: string;
  reason: string;
  regime?: string;
  regime1h?: string;
  suggestedLeverage?: number;
  suggestedAmountPct?: number;
}

export interface StrategyReport {
  analyses: CompatibilityAnalysis[];
  portfolioRisk: { riskLevel: string; totalExposurePct: number; atPositionLimit: boolean; analysis: string };
  summary: string;
  aiPromptContext: string;
  directSignals: DirectTradeSignal[];
}

// 全局实例
const trendAgent = new TrendAgent("trend-1");
const reversionAgent = new MeanReversionAgent("reversion-1");
const coordinator = new Coordinator({ kellySafetyFactor: 2 });

function buildMarketSnapshot(
  sym: string,
  ticker: MarketData,
  ohlcv: Record<string, any[]>,
): { snapshot: MarketSnapshot | null; ind: TechnicalIndicators | null } {
  const c1h = ohlcv["1h"] ? convertCandles(ohlcv["1h"]) : [];
  const c1d = ohlcv["1d"] ? convertCandles(ohlcv["1d"]) : [];

  if (c1h.length < 50) return { snapshot: null, ind: null };

  const closes1h = c1h.map(x => x[4]);
  const highs1h = c1h.map(x => x[2]);
  const lows1h = c1h.map(x => x[3]);
  const volumes1h = c1h.map(x => x[5]);

  const closes1d = c1d.length > 0 ? c1d.map(x => x[4]) : [];
  const highs1d = c1d.length > 0 ? c1d.map(x => x[2]) : [];
  const lows1d = c1d.length > 0 ? c1d.map(x => x[3]) : [];
  const volumes1d = c1d.length > 0 ? c1d.map(x => x[5]) : [];

  const ind = calcTechnicalFromOhlcv(ohlcv["1h"]);
  if (!ind) return { snapshot: null, ind: null };

  const snapshot: MarketSnapshot = {
    symbol: sym,
    price: ticker.price,
    bid: ticker.bid,
    ask: ticker.ask,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    volume24h: ticker.volume24h,
    change24h: ticker.change24h,
    fundingRate: ticker.fundingRate ?? 0,
    closes_1h: closes1h,
    highs_1h: highs1h,
    lows_1h: lows1h,
    volumes_1h: volumes1h,
    closes_1d: closes1d,
    highs_1d: highs1d,
    lows_1d: lows1d,
    volumes_1d: volumes1d,
  };

  return { snapshot, ind };
}

function classifyRegime(ind: TechnicalIndicators, dailyUp: boolean, dailyAdx: number, ci?: number | null): string {
  const oscThr = interceptParamsCache.get("regime_osc_threshold") ?? 18;
  const weakThr = interceptParamsCache.get("regime_weak_threshold") ?? 25;
  const strongThr = interceptParamsCache.get("regime_strong_threshold") ?? 40;
  const ciThrChop = interceptParamsCache.get("ci_choppy_threshold") ?? 62;
  const ciThrTrend = interceptParamsCache.get("ci_trend_threshold") ?? 38;

  // 混沌指数强信号覆盖：CI > 62 时强行判为震荡
  if (ci !== null && ci !== undefined && ci > ciThrChop) return "纯震荡";

  // CI < 38 时趋势确认，用 ADX 细分
  if (ci !== null && ci !== undefined && ci < ciThrTrend) {
    if (dailyAdx <= weakThr) return dailyUp ? "震荡偏多" : "震荡偏空";
    if (dailyAdx < strongThr) return dailyUp ? "弱趋势多" : "弱趋势空";
    return dailyUp ? "强趋势多" : "强趋势空";
  }

  // 无 CI / CI 在中间区 → 原 ADX 逻辑
  if (dailyAdx < oscThr) return "纯震荡";
  if (dailyAdx < weakThr) return dailyUp ? "震荡偏多" : "震荡偏空";
  if (dailyAdx < strongThr) return dailyUp ? "弱趋势多" : "弱趋势空";
  return dailyUp ? "强趋势多" : "强趋势空";
}

/** 计算多周期快照（供 AI 和 supplemental detail） */
function buildTfSnapshots(ohlcv: Record<string, any[]>): TfSnapshot[] {
  const snapshots: TfSnapshot[] = [];
  for (const tf of ["1m", "5m", "15m", "1h", "1d"]) {
    const raw = ohlcv[tf];
    if (!raw || raw.length < 6) {
      snapshots.push({ tf, chg: 0, adx: 0, rsi: 50, atrPct: 0, ema20Up: false, bbPosition: 50, volRatio: 1, macdSignal: "无信号" });
      continue;
    }
    const arr = convertCandles(raw);
    // 1h/1d 用完整指标（含MACD），短周期用简化指标
    const isLongTf = tf === "1h" || tf === "1d";
    const ind = isLongTf
      ? calcTechnicalIndicators(arr.map(x => x[4]), arr.map(x => x[2]), arr.map(x => x[3]), arr.map(x => x[5]))
      : null;
    const simpleInd = !ind ? calcIndicators(arr) : null;

    const price = arr[arr.length - 1][4];
    const openFirst = arr[0][4];
    const chg = openFirst > 0 ? ((price - openFirst) / openFirst) * 100 : 0;

    const adx = ind?.adx ?? simpleInd?.adx ?? 0;
    const rsi = ind?.rsi14 ?? simpleInd?.rsi14 ?? 50;
    const atrPct = ind ? ind.atrPct : simpleInd && simpleInd.atr14 > 0 ? (simpleInd.atr14 / price * 100) : 0;
    const ema20Up = ind ? price > ind.ema20 : simpleInd ? price > simpleInd.ema20 : false;

    let bbPos = 50;
    if (ind) {
      bbPos = ind.bbUpper > ind.bbLower ? ((price - ind.bbLower) / (ind.bbUpper - ind.bbLower)) * 100 : 50;
    } else if (simpleInd) {
      bbPos = simpleInd.bbUpper > simpleInd.bbLower ? ((price - simpleInd.bbLower) / (simpleInd.bbUpper - simpleInd.bbLower)) * 100 : 50;
    }

    let volRatio = 1;
    if (ind) {
      volRatio = ind.volumeRatio;
    } else if (simpleInd) {
      const volArr = arr.map(x => x[5]);
      const avgVol = simpleInd.volumeAvg || 1;
      volRatio = avgVol > 0 ? volArr[volArr.length - 1] / avgVol : 1;
    }

    const macdSignal = ind?.macdSignal ?? "无信号";

    snapshots.push({ tf, chg, adx, rsi, atrPct, ema20Up, bbPosition: bbPos, volRatio, macdSignal });
  }
  return snapshots;
}

function computeMarketQuality(ticker: MarketData, ohlcv: Record<string, any[]>): number {
  const raw1h = ohlcv["1h"] || [];
  const raw15m = ohlcv["15m"] || [];
  const raw5m = ohlcv["5m"] || [];

  const toArr = (raw: any[]) => raw.map((c: any) => [
    0, c.open ?? 0, c.high ?? 0, c.low ?? 0, c.close ?? 0, c.volume ?? 0,
  ] as number[]);

  if (raw1h.length >= 6) {
    return calcMarketQuality(toArr(raw1h), toArr(raw15m), toArr(raw5m), ticker.fundingRate ?? 0);
  }
  return 50;
}

export async function runStrategyEngine(
  tickers: Map<string, MarketData>,
  ohlcvData: Map<string, Record<string, any[]>>,
  positions: Position[],
  account: AccountInfo,
): Promise<StrategyReport> {
  const analyses: SymbolAnalysis[] = [];
  const existingSymbols = new Set(positions.map(p => p.symbol));
  const reportLines: string[] = [];
  const directSignals: DirectTradeSignal[] = [];
  const allSignalCandidates: any[] = [];

  reportLines.push("## ShangAI 策略引擎 — 趋势智能体分析\n");

  for (const sym of CONFIG.symbols) {
    const ticker = tickers.get(sym);
    const ohlcv = ohlcvData.get(sym);
    if (!ticker || !ohlcv) {
      logger.warn(`[SA-Engine] ${sym} 数据不足,跳过`);
      continue;
    }

    const { snapshot, ind } = buildMarketSnapshot(sym, ticker, ohlcv);
    if (!snapshot || !ind) {
      logger.warn(`[SA-Engine] ${sym} 技术指标不足(需≥50根K线),跳过`);
      continue;
    }

    // === CI 计算 ===
    const ciVal = snapshot.highs_1h.length >= 14
      ? calcChoppinessIndex(snapshot.highs_1h, snapshot.lows_1h, snapshot.closes_1h, 14) : null;
    // === 按行情选智能体：CI>55=震荡→均值回归，CI<38=趋势→TrendAgent ===
    // 用 CI+regime 双重判断（CI>55或纯震荡→均值回归，震荡偏/弱趋势且趋势无信号→试回归）
    const c1d2 = ohlcv["1d"] ? convertCandles(ohlcv["1d"]) : [];
    const id2 = c1d2.length >= 50 ? calcTechnicalFromOhlcv(ohlcv["1d"]) : null;
    const preRegime = classifyRegime(ind, id2 ? id2.ema20 > id2.ema50 : ind.ema20 > ind.ema50, id2 ? id2.adx : ind.adx, ciVal);
    // === 双智能体跑，Coordinator 仲裁 ===
    const trendSig = trendAgent.analyze(snapshot, ind);
    const revSig = reversionAgent.analyze(snapshot, ind);
    const signal = trendSig.confidence >= revSig.confidence ? trendSig : revSig;
    allSignalCandidates.push({ ...trendSig, indicators: ind } as any);
    if (revSig.action !== "hold") allSignalCandidates.push({ ...revSig, indicators: ind } as any);
    logger.info(`[Coord] ${sym}: Trend=(${trendSig.action}${trendSig.confidence}%) Rev=(${revSig.action}${revSig.confidence}%) | CI=${ciVal?.toFixed(1)||'?'}`);
    // (will be re-used later when building directSignals)

    // === 3. 行情质量 ===
    const marketQuality = computeMarketQuality(ticker, ohlcv);

    // === 多周期快照（供 AI 填充 1m/5m/15m/1h/1d 列） ===
    const snapshots = buildTfSnapshots(ohlcv);

    // === 复用已算好的 regime（避免重复计算） ===
    const regime = preRegime;
    const regime1h = classifyRegime(ind, ind.ema20 > ind.ema50, ind.adx, ciVal);
    const dailyUp = id2 ? id2.ema20 > id2.ema50 : ind.ema20 > ind.ema50;
    const dailyAdx = id2 ? id2.adx : ind.adx;

    // (directSignals now handled by Coordinator)
    if (false && signal.action !== "hold") {
      directSignals.push({
        action: signal.action,
        symbol: signal.symbol,
        direction: signal.action === "buy" ? "bullish" : "bearish",
        confidence: Math.max(1, Math.min(10, Math.round(signal.confidence / 10))),
        riskFlag: signal.confidence < 40 ? "低置信度" : "",
        reason: `[SA-Trend] ${signal.reason.slice(0, 80)}`,
        regime,
        regime1h,
      });
    }

    // === ATR/RSI 缓存 ===
    const atrPct = ind.atrPct;
    const safeAtrPct = (atrPct > 50 || atrPct < 0.01) ? 1.5 : atrPct;
    setAtrCache(sym, safeAtrPct / 100);
    setRsiCache(sym, Math.round(ind.rsi14));

    // 填充 indicatorCache（供 opt_rules + 监控使用）
    setIndicatorCache(sym, {
      regime,
      rsi_1h: Math.round(ind.rsi14),
      rsi_1d: id2 ? Math.round(id2.rsi14) : 50,
      adx_1h: Math.round(ind.adx),
      adx_1d: Math.round(dailyAdx),
      atr_pct: safeAtrPct,
      ema_dist_pct: ((snapshot.price - ind.ema20) / ind.ema20 * 100),
    });

    // === 6. 组件可兼容分析结果 ===
    const analysis: SymbolAnalysis = {
      symbol: sym,
      trendSignal: signal,
      decision: null,
      regime,
      marketQuality,
      summary: `${sym} ${signal.action} 置信度${signal.confidence}% ${signal.reason.slice(0, 60)}`,
    };
    analyses.push(analysis);

    // AI Prompt 内容
    const direction = signal.action === "buy" ? "做多" : signal.action === "sell" ? "做空" : "观望";
    const regimeLabel = `${regime} | ADX${ind.adx.toFixed(0)} RSI${ind.rsi14.toFixed(0)} ATR${atrPct.toFixed(2)}%`;
    reportLines.push(`\n### ${sym}`);
    reportLines.push(`【趋势智能体】方向:${direction} 置信度:${signal.confidence}%`);
    reportLines.push(`行情分类: ${regimeLabel}`);
    reportLines.push(`指标: EMA20=${ind.ema20.toFixed(2)} EMA50=${ind.ema50.toFixed(2)} BB=[${ind.bbLower.toFixed(4)},${ind.bbUpper.toFixed(4)}]`);
    reportLines.push(`MACD: ${ind.macdSignal} 量比: ${ind.volumeRatio.toFixed(2)}×`);
    reportLines.push(`推理: ${signal.reason}`);
    reportLines.push(`行情质量评分: ${marketQuality}/100`);
    // 多周期快照（逐行展示，供 AI 填充 analysis_1m/5m/15m/1h/1d）
    for (const s of snapshots) {
      if (s.adx <= 0) continue;
      reportLines.push(`  ${s.tf}: 涨跌${s.chg >= 0 ? "+" : ""}${s.chg.toFixed(1)}% ADX${s.adx.toFixed(0)} RSI${s.rsi.toFixed(0)} ATR${s.atrPct.toFixed(2)}% EMA20${s.ema20Up ? "↑" : "↓"} BB${s.bbPosition.toFixed(0)}% 量${s.volRatio.toFixed(1)}x ${s.macdSignal}`);
    }
    reportLines.push(`  入场建议: ${signal.action === "buy" ? `做多(conf=${signal.confidence}%, 杠杆${signal.suggestedLeverage}x)` : signal.action === "sell" ? `做空(conf=${signal.confidence}%, 杠杆${signal.suggestedLeverage}x)` : "观望"}`);
  }

  // === Coordinator 仲裁 + 凯利分配 ===
  try {
    if (allSignalCandidates.length > 0) {
      const decisions = await coordinator.evaluate(allSignalCandidates);
      const approvedMap = new Map<string, any>();
      for (const d of decisions) if (d.riskApproved) approvedMap.set(d.signal.symbol, d);
      for (const [sym, d] of approvedMap) {
        const s = d.signal;
        directSignals.push({
          action: s.action as any, symbol: s.symbol,
          direction: s.action === "buy" ? "bullish" : "bearish",
          confidence: Math.max(1, Math.min(10, Math.round((s.confidence||0) / 10))),
          riskFlag: "", reason: (s.reason||"").slice(0, 100),
          regime: "→", regime1h: "→",
          suggestedLeverage: d.adjustedLeverage, suggestedAmountPct: d.adjustedAmountPct,
        });
      }
    }
  } catch {}

  // === 组合风控信息 ===
  const totalExposurePct = account.totalEquity > 0 ? (account.marginUsed / account.totalEquity) * 100 : 0;
  const atPositionLimit = positions.length >= CONFIG.maxPositions;
  let riskLevel = "safe";
  if (totalExposurePct < 15) riskLevel = "safe";
  else if (totalExposurePct < 30) riskLevel = "moderate";
  else if (totalExposurePct < 50) riskLevel = "high";
  else riskLevel = "critical";

  const portfolioLine = `【组合风控】敞口:${totalExposurePct.toFixed(1)}% 持仓:${positions.length}/${CONFIG.maxPositions} 风险:${riskLevel} 可用:$${account.availableBalance.toFixed(0)}`;
  const summary = `【ShangAI策略引擎】${analyses.length}币种 | 组合风险:${riskLevel} | ${atPositionLimit ? "已达上限" : "可开新仓"}`;

  reportLines.push(`\n${portfolioLine}`);
  reportLines.push(`\n## 评分使用规则（必须遵守）`);
  reportLines.push(`- 趋势智能体信号的方向(做多/做空/观望)和置信度是核心参考`);
  reportLines.push(`- 行情质量<20分时信号可靠性下降`);
  reportLines.push(`- ADX>50配合MACD确认的方向信号可信度高`);
  reportLines.push(`- 已有持仓时:趋势反转+MACD背离才考虑平仓，浮盈回吐不是平仓理由`);
  reportLines.push(`- 只能对"当前持仓"列表中有的币种输出close`);
  reportLines.push(`\n【策略引擎评估摘要】${summary}`);

  const aiPromptContext = reportLines.join("\n");

  // 构建兼容旧接口的分析数组
  const compatAnalyses: CompatibilityAnalysis[] = analyses.map((a, i) => {
    // 重新计算该币种的快照以传递到 supplemental detail
    const ohlcv = ohlcvData.get(a.symbol);
    const ss = ohlcv ? buildTfSnapshots(ohlcv) : [];
    return {
      symbol: a.symbol,
      sentiment: { marketQuality: a.marketQuality },
      entryQuality: {
        longEntryScore: a.trendSignal.action === "buy" ? a.trendSignal.confidence : 50 - Math.round(a.trendSignal.confidence / 3),
        shortEntryScore: a.trendSignal.action === "sell" ? a.trendSignal.confidence : 50 - Math.round(a.trendSignal.confidence / 3),
      },
      technical: {
        directionBias: a.trendSignal.action === "buy" ? "bullish" : a.trendSignal.action === "sell" ? "bearish" : "neutral",
        snapshots: ss,
      },
      backtestSummary: "",
      trendSignal: a.trendSignal,
    };
  });

  return {
    analyses: compatAnalyses,
    portfolioRisk: {
      riskLevel,
      totalExposurePct,
      atPositionLimit,
      analysis: portfolioLine,
    },
    summary,
    aiPromptContext,
    directSignals,
  };
}

/** 将策略信号同步传给 Coordinator（现有 index.ts 是同步调用 runStrategyEngine，我们保持同步） */
function awaitCoordinatorSync(signals: StrategySignal[]): TradeDecision[] {
  // Coordinator.evaluate 是 async，但在这里我们只取第一个信号的结果做参考
  // 实际决策由 AI 管道做最终裁定，Coordinator 信号作为参考内容写入 aiPromptContext
  return [];
}

export { TrendAgent, Coordinator };
