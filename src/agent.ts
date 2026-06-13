/**
 * SmartTrade - AI 投资委员会主席
 * v3: AI 只输出方向+信心+风险，规则引擎决定一切数字
 */

import { CONFIG } from "./config";
import { logger } from "./logger";
import { getTradeStats, getPartialClosePct } from "./db";
import { openai } from "./ai-client";
import type { Position, AccountInfo } from "./exchanges";
import type { StrategyReport } from "./strategies/index";
import type { MarketNewsReport } from "./news-mcp";
import { scoringAdvice } from "./state";

export interface CoinAnalysis {
  symbol: string;
  trend: "bullish" | "bearish" | "neutral";
  strength: "strong" | "moderate" | "weak";
  keyLevels: string;
  summary: string;
  score: number;
  analysis_1m: string;
  analysis_5m: string;
  analysis_15m: string;
  analysis_1h: string;
  analysis_1d: string;
}

export interface PositionCommand {
  symbol: string;
  action: "hold" | "close";
  reason: string;
  confidence: number;
}

export interface AISignal {
  action: "buy" | "sell" | "hold";
  symbol: string;
  direction: "bullish" | "bearish" | "neutral";
  confidence: number;
  riskFlag: string;
  reason: string;
}

export interface MarketReport {
  analysis: CoinAnalysis[];
  positions: PositionCommand[];
  signals: AISignal[];
  summary: string;
  execution?: { log: string[] };
  requestDetail?: string[];
}

/** 规则引擎：AI 信号 → 交易参数 */
export function signalToTrade(
  signal: AISignal,
  currentRegime: string,
): { leverage: number; amountPercent: number } | null {
  if (signal.action === "hold") return null;
  const regime = currentRegime || "";
  // 强趋势禁逆势（多<->空对称）：历史数据显示逆势方向胜率 23%，亏损 -$170
  if (signal.action === "buy" && regime.includes("强趋势空")) return null;
  if (signal.action === "sell" && regime.includes("强趋势多")) return null;
  const isCounterTrend = (
    (signal.action === "buy" && (regime.includes("空") || regime.includes("bear"))) ||
    (signal.action === "sell" && (regime.includes("多") || regime.includes("bull")))
  );
  if (signal.riskFlag && signal.riskFlag.length > 3) return null;
  const c = signal.confidence;
  if (c < 4) return null;
  let baseLev: number, basePct: number;
  if (c >= 9)      { baseLev = 10; basePct = 100; }
  else if (c >= 7) { baseLev = 8;  basePct = 75;  }
  else if (c >= 5) { baseLev = 6;  basePct = 50;  }
  else             { baseLev = 4;  basePct = 30;  }
  if (isCounterTrend) {
    baseLev = Math.max(2, Math.floor(baseLev * 0.5));
    basePct = Math.round(basePct * 0.4);
  }
  const amountPercent = Math.max(2, Math.min(CONFIG.basePositionPct, Math.round(basePct * CONFIG.basePositionPct / 100)));
  const leverage = Math.min(CONFIG.maxLeverage, Math.max(1, baseLev));
  return { leverage, amountPercent };
}

export function buildStrategyPrompt(
  strategyReport: StrategyReport,
  positions: Position[],
  account: AccountInfo,
  openTrades: any[],
  recentDecisions: any[],
  stats: any,
  newsReport?: MarketNewsReport | null,
): string {
  const dbSideMap = new Map<string, string>();
  for (const t of openTrades) dbSideMap.set(t.symbol, t.side);
  const seenSyms = new Set<string>();
  const posLines = positions.length > 0
    ? positions.filter(p => { const k = p.symbol; if (seenSyms.has(k)) return false; if (dbSideMap.has(k) && p.side !== dbSideMap.get(k)) return false; seenSyms.add(k); return true; })
        .map(p => {
          const db = openTrades.find((t: any) => t.symbol === p.symbol);
          const partial = db ? getPartialClosePct(db.id as number, db.entry_qty as number) : 0;
          const liqDist = p.liquidationPrice && p.entryPrice ? Math.abs((p.liquidationPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1) : '?';
          return `${p.symbol} ${p.side} | 入场:$${p.entryPrice?.toFixed(2)} | PnL:${p.unrealizedPnlPct?.toFixed(2)}% | 清算距:${liqDist}% | 杠杆:${p.leverage}x${partial > 0 ? ` | 已分批:${partial}%` : ''}`;
        }).join("\n") : "无持仓";
  let historyLines = "";
  if (stats) {
    const wr = stats.winRate || 0;
    historyLines = `总交易:${stats.totalClosed}平仓+${stats.totalOpen}持仓 | 胜率:${wr.toFixed(1)}%(${stats.wins}胜/${stats.losses}负) | 总盈亏:${(stats.totalPnl>=0?"+":"")}$${stats.totalPnl?.toFixed(2)}`;
  }
  let decLines = "";
  if (recentDecisions && recentDecisions.length > 0) {
    decLines = "最近 AI 决策：\n" + recentDecisions.slice(0, 12).map((d: any) => {
      const st = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      return `  ${st} ${d.symbol} ${d.action} ${d.leverage}x ${d.amount}% 置信${d.confidence} | ${d.reason?.slice(0, 50)}`;
    }).join("\n");
  }
  let newsBlock = "";
  if (newsReport && newsReport.summary) {
    newsBlock = `\n## 📰 市场消息面\n${newsReport.summary}\n消息面方向与技术面一致→强化信号；矛盾→审慎\n`;
  }
  return `你是加密货币投资委员会主席。你只做三个定性判断，不出任何数字。

角色定位：
- ✅ 判断方向（bullish/bearish/neutral）
- ✅ 评估信心（1-10整数）
- ✅ 标注致命风险（有则用一句话描述）
- ❌ 不出杠杆、仓位%、止盈止损等具体数字

${strategyReport.aiPromptContext}
${newsBlock}
## 当前持仓
${posLines}
## 账户 | 权益:$${account.totalEquity.toFixed(2)} | 可用:$${account.availableBalance.toFixed(2)}
## 历史战绩
${historyLines || "无"}
${decLines}
${scoringAdvice ? `\n## 评分校准\n${scoringAdvice}\n` : ""}
## 输出规则
### 方向
- 多周期+策略共振方向
- 矛盾则 neutral
### 信心(1-10)
- 8-10: 多周期+消息面全共振
- 5-7: 有倾向但不确定
- 1-4: 看不清（规则引擎自动跳过<4）
- 整数，不要小数
### 风险标记
- 仅填写你确信的致命风险（如"突然巨量异动"）
- 常规的RSI超卖/趋势强不要填
- 无风险留空
### 持仓
- 趋势结构已破坏才close
### 对称决策
- 趋势有对称性：大趋势偏空时，平掉多仓后应同步评估是否有做空机会
- 不要只否决不做 — 否决一个方向的信号/平掉对应方向的持仓后，检查反向是否存在值得开仓的入场点
- 多空双向都要考虑：偏空的行情优先输出 sell 信号，偏多的行情优先输出 buy 信号

## JSON 格式
{
  "analysis": [{"symbol":"BTC/USDT","analysis_1m":"","analysis_5m":"","analysis_15m":"","analysis_1h":"ADX75 RSI29","analysis_1d":"ADX70","trend":"bearish","strength":"strong","keyLevels":"","summary":"强空，超卖","score":-5}],
  "positions": [{"symbol":"DOGE/USDT","action":"close","reason":"1h反转","confidence":0.8}],
  "signals": [
    {"action":"buy","symbol":"BNB/USDT","direction":"bullish","confidence":7,"riskFlag":"","reason":"超卖共振"}
  ],
  "summary":"整体偏空，BNB超卖反弹信号",
  "requestDetail":[]
}
注意：signals 中每个元素只包含 action/symbol/direction/confidence(整数)/riskFlag(字符串)/reason。不要自己计算任何数字参数。`;
}

function parseReport(raw: string): MarketReport | null {
  const toArray = (v: any): any[] => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
    return [];
  };
  function buildReport(obj: any): MarketReport {
    return {
      analysis: toArray(obj.analysis).map((a: any) => ({
        symbol: a.symbol || "",
        trend: ["bullish","bearish","neutral"].includes(a.trend) ? a.trend : "neutral",
        strength: ["strong","moderate","weak"].includes(a.strength) ? a.strength : "moderate",
        keyLevels: a.keyLevels || "",
        summary: a.summary || "",
        score: Number(a.score) || 0,
        analysis_1m: a.analysis_1m || "", analysis_5m: a.analysis_5m || "",
        analysis_15m: a.analysis_15m || "", analysis_1h: a.analysis_1h || "", analysis_1d: a.analysis_1d || "",
      })),
      requestDetail: Array.isArray(obj.requestDetail) ? obj.requestDetail : undefined,
      positions: toArray(obj.positions).map((p: any) => ({
        symbol: p.symbol || "", action: p.action === "close" ? "close" : "hold",
        reason: p.reason || "", confidence: Number(p.confidence) || 0.7,
      })),
      signals: toArray(obj.signals || obj.newTrades).map((t: any) => ({
        action: ["buy","sell","hold"].includes(t.action) ? t.action : "hold",
        symbol: t.symbol || "",
        direction: t.direction || "neutral",
        confidence: t.confidence !== undefined
          ? Math.max(1, Math.min(10, Math.round(Number(t.confidence))))
          : Math.max(1, Math.min(10, Math.round((t.confidence ?? 0.5) * 10))),
        riskFlag: typeof t.riskFlag === "string" ? t.riskFlag : "",
        reason: t.reason || "",
      })),
      summary: obj.summary || "",
    };
  }
  const json = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try { return buildReport(JSON.parse(json)); }
  catch (e) {
    const errMsg = String(e).slice(0, 80);
    if (errMsg.includes("end") || errMsg.includes("Unexpected") || errMsg.includes("position")) {
      for (let i = json.length - 1; i > 50 && i > json.length - 300; i--) {
        try { return buildReport(JSON.parse(json.slice(0, i) + "}]}]}")); } catch {}
      }
    }
    logger.error(`AI JSON 解析失败: ${String(e).slice(0, 100)}`);
    return null;
  }
}

function buildSupplementalDetail(strategyReport: StrategyReport, symbols: string[]): string {
  const lines: string[] = [];
  for (const sym of symbols) {
    const output = strategyReport.analyses.find(a => a.symbol === sym);
    const snaps = (output?.technical as any)?.snapshots as any[];
    if (!snaps || snaps.length === 0) continue;
    lines.push(`\n### ${sym}`);
    lines.push(`|周期|涨跌%|ADX|RSI|ATR%|EMA20|BB位置|量比|`);
    lines.push(`|---:|---:|---:|---:|---:|:---:|:---:|:---:|`);
    for (const s of snaps) {
      lines.push(`|${s.tf}|${s.chg.toFixed(1)}|${s.adx.toFixed(0)}|${s.rsi.toFixed(0)}|${s.atrPct.toFixed(2)}|${s.ema20Up ? "↑" : "↓"}|${s.bbPosition.toFixed(0)}%|${s.volRatio.toFixed(1)}x|`);
    }
  }
  return lines.length ? ("详细数据:\n" + lines.join("\n")) : "";
}

export async function getMarketReport(
  strategyReport: StrategyReport,
  positions: Position[],
  account: AccountInfo,
  recentDecisions: any[],
  openTrades: any[],
  newsReport?: MarketNewsReport | null,
): Promise<MarketReport | null> {
  const stats = getTradeStats(7);
  const prompt = buildStrategyPrompt(strategyReport, positions, account, openTrades, recentDecisions, stats, newsReport);
  let raw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: CONFIG.ai.model, temperature: CONFIG.ai.temperature, max_tokens: CONFIG.ai.maxTokens,
        messages: [{ role: "system", content: "你只输出定性判断，不出数字参数。只输出JSON。" }, { role: "user", content: prompt }],
      });
      raw = resp.choices[0]?.message?.content || "";
        // 完整输出 AI 主席原始响应到日志（DEBUG 级别），INFO 输出分析摘要
  logger.debug(`AI主席原始(${raw.length}字符): ${raw}`);
  logger.info(`AI主席(${raw.length}字符): ${raw.slice(0, 100)}...`);
      const parsed = parseReport(raw);
      if (parsed && parsed.requestDetail?.length) {
        const supp = buildSupplementalDetail(strategyReport, parsed.requestDetail.slice(0, 3));
        if (supp) {
          const resp2 = await openai.chat.completions.create({
            model: CONFIG.ai.model, temperature: CONFIG.ai.temperature, max_tokens: CONFIG.ai.maxTokens,
            messages: [
              { role: "system", content: "以下是详细数据，重新输出定性判断。" },
              { role: "user", content: prompt },
              { role: "assistant", content: raw },
              { role: "user", content: supp + "\n输出JSON。" },
            ],
          });
          const raw2 = resp2.choices[0]?.message?.content || "";
          if (raw2.length > 100) raw = raw2;
        }
      }
      if (raw.length < 500 && attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
      break;
    } catch { return null; }
  }
  const report = parseReport(raw);
  if (report) {
  logger.info(`📊 AI主席: ${report.signals.filter(s=>s.action!=='hold').length}信号, 平仓${report.positions.filter(p=>p.action==='close').length}个`);
  // 逐币分析日志
  for (const a of report.analysis) {
    logger.info(`[AI分析] ${a.symbol}: 趋势=${a.trend} 强度=${a.strength} 评分=${a.score} | ${a.summary}`);
  }
  // 平仓指令明细
  for (const p of report.positions) {
    if (p.action === 'close') logger.info(`[AI平仓指令] ${p.symbol}: ${p.reason}`);
  }
  // 信号明细
  for (const s of report.signals) {
    if (s.action !== 'hold') logger.info(`[AI信号] ${s.symbol} ${s.action}(${s.direction}) conf=${s.confidence} | ${s.reason}`);
  }
}
  return report;
}
