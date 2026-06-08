/**
 * SmartTrade - AI 投资委员会主席（模式C：策略层分析 → AI综合决策）
 *
 * 替代旧版"AI交易员"模式。
 * AI 接收三个独立策略(技术面/资金面/风控)的结构化分析,
 * 作为"投资委员会主席"综合判断后输出最终决策。
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { getTradeStats, getPartialClosePct } from "./db";
import { openai } from "./ai-client";
import type { Position, AccountInfo } from "./exchanges";
import type { StrategyReport } from "./strategies/index";
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

export interface TradeEntry {
  action: "buy" | "sell" | "hold";
  symbol: string;
  leverage: number;
  amountPercent: number;
  reason: string;
  confidence: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export interface MarketReport {
  analysis: CoinAnalysis[];
  positions: PositionCommand[];
  newTrades: TradeEntry[];
  summary: string;
  execution?: { log: string[] };
}

/**
 * 构建策略驱动的 AI prompt
 */
function buildStrategyPrompt(
  strategyReport: StrategyReport,
  positions: Position[],
  account: AccountInfo,
  openTrades: any[],
  recentDecisions: any[],
  stats: any,
): string {
  // 当前持仓（按DB确认的side去重，防交易所结算延迟导致同一币种多方向幽灵仓）
  const dbSideMap = new Map<string, string>();
  for (const t of openTrades) dbSideMap.set(t.symbol, t.side);
  const seenSyms = new Set<string>();
  const posLines = positions.length > 0
    ? positions
        .filter(p => {
          const key = p.symbol;
          if (seenSyms.has(key)) return false;
          if (dbSideMap.has(key) && p.side !== dbSideMap.get(key)) return false;
          seenSyms.add(key);
          return true;
        })
        .map(p => {
          const db = openTrades.find((t: any) => t.symbol === p.symbol);
          const partial = db ? getPartialClosePct(db.id as number, db.entry_qty as number) : 0;
          const liqDist = p.liquidationPrice && p.entryPrice
            ? Math.abs((p.liquidationPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1)
            : '?';
          return `${p.symbol} ${p.side} | 入场:$${p.entryPrice?.toFixed(2)} | PnL:${p.unrealizedPnlPct?.toFixed(2)}% | 清算距:${liqDist}% | 杠杆:${p.leverage}x${partial > 0 ? ` | 已分批:${partial}%` : ''}`;
        }).join("\n")
    : "无持仓";

  // 历史战绩
  let historyLines = "";
  if (stats) {
    const wr = stats.winRate || 0;
    historyLines = `总交易:${stats.totalClosed}平仓+${stats.totalOpen}持仓 | 胜率:${wr.toFixed(1)}%(${stats.wins}胜/${stats.losses}负) | 总盈亏:${(stats.totalPnl>=0?"+":"")}$${stats.totalPnl?.toFixed(2)} | 最大盈利:$${stats.maxWin?.toFixed(2)} 最大亏损:$${stats.maxLoss?.toFixed(2)}`;
    if (stats.bySymbol) {
      const bsEntries = Object.entries(stats.bySymbol) as [string, any][];
      historyLines += "\n按币种：" + bsEntries.map(([sym, s]) => {
        const swr = s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100).toFixed(0) : "0";
        return `${sym}:${swr}%(${s.wins}W/${s.losses}L) PnL:$${s.pnl?.toFixed(2)}`;
      }).join(" | ");
    }
  }

  // 最近 AI 决策
  let decLines = "";
  if (recentDecisions && recentDecisions.length > 0) {
    decLines = "最近 AI 决策：\n" + recentDecisions.slice(0, 12).map((d: any) => {
      const st = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      return `  ${st} ${d.symbol} ${d.action} ${d.leverage}x ${d.amount}% 置信${d.confidence} | ${d.reason?.slice(0, 50)}`;
    }).join("\n");
  }

  return `你是加密货币投资委员会主席。三个独立的 AI 策略已分别完成分析，以下是它们对每个币种的评估报告。

你的角色：不是复述数据，而是**综合不同策略的观点，发现矛盾，做出最终交易决策**。

---

${strategyReport.aiPromptContext}

---

## 当前持仓（最高优先级）
${posLines}

## 账户 | 权益:$${account.totalEquity.toFixed(2)} | 可用:$${account.availableBalance.toFixed(2)} | 杠杆上限:${CONFIG.maxLeverage}x | 仓位上限:${CONFIG.maxPositions}

## 历史战绩（近7日）
${historyLines || "无历史数据"}
${decLines ? "\n" + decLines : ""}

${scoringAdvice ? `## 评分校准建议（基于近期复盘）
${scoringAdvice}

` : ""}
## 🔍 复盘反省（必须做）
你的历史战绩显示总盈亏${(stats && stats.totalPnl) ? `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}` : "$0"}。请分析：
- **近期亏损单的共同特征是什么**？方向？入场时机？止损位置？
- 当前市场状态和之前比有变化吗？你的策略是否需要调整？
- **多空平等**，不要死扛一个方向

## 你的任务（输出交易决策）

### 1. 策略观点综合
对每个币种，三个策略可能给出不同方向：
- **技术面**：多周期K线趋势方向
- **资金面**：费率拥挤度 + 成交量流向
- **风控**：波动率适应的仓位/杠杆建议

当策略同向 → 强信号；当策略矛盾 → 需要你判断哪个更可信（通常回测历史上哪个策略准确率高就倾向哪边）。

风控策略的 riskAppetite 必须遵守，注意它只影响新开仓：
- avoid → 不开新仓（但不影响已有持仓是否持有）
- low → 新仓仅轻仓(≤25%标准仓位)
- medium → 新仓半仓
- high → 新仓可以满仓

### 2. 持仓管理（平仓决策）
平仓理由仅限于**价格结构已破坏**——需要两个以上条件确认反转：
- ✅ 价格突破 EMA20 且站稳（非假突破）
- ✅ 多周期（1h+4h+1d）方向一致转多/转空
- ✅ 关键支撑/阻力位被击穿
- ❌ RSI 超卖/超买不能作为反转理由（趋势中 RSI 可以持续超卖）
- ❌ BB 触及上/下轨不能作为反转理由
- ⚠️ 风控策略给出的"建议止损/止盈"数字仅供新开仓规划参考，**不作为已有持仓的平仓理由**
- 盈利收窄（峰值回吐超过一半）→ 锁利平仓
- 持仓亏损且趋势已反转（需以上价格结构确认）→ 止损离场
- 入场理由不再成立（例如做空原因是强趋势，但趋势已转多）→ 平仓
- **不要为了输出close而输出close。没有合适的理由就全部hold。**

### 3. 新开仓
基于策略分析给出 buy/sell/hold 决策。
- 已有持仓的币种可以继续开仓（追仓），系统自动合并管理仓位
- 杠杆不超过风控策略的 suggestedLeverage
- 仓位不超过风控策略的 suggestedAmountPct
- 止损/止盈参考风控策略的 suggestedStopLossPct / suggestedTakeProfitPct

## JSON 格式
{
  "analysis": [
    {"symbol":"BTC/USDT","analysis_1m":"5m:ADX62放量跌","analysis_5m":"","analysis_15m":"15m:ADX80超卖","analysis_1h":"1h:ADX75 RSI32 触及BB下轨","analysis_1d":"日线:ADX70 RSI29 超卖区","trend":"bearish","strength":"strong","keyLevels":"支撑64500 阻力67500","summary":"日线强空但RSI超卖,短周期有反弹可能,追空风险大","score":-5}
  ],
  "positions": [
    {"symbol":"DOGE/USDT","action":"close","reason":"1h方向反转+量萎缩,平仓观察","confidence":0.7}
  ],
  "newTrades": [
    {"action":"sell","symbol":"AAVE/USDT","leverage":3,"amountPercent":8,"reason":"技术面强空+资金面费率中性,风控建议半仓","confidence":0.65,"stopLossPct":4,"takeProfitPct":12}
  ],
  "summary": "【决策】整体偏空但多币种RSI超卖。持仓3个继续hold,DOGE信号转弱平仓。新仓等策略确认后再入。"
}`;
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
        analysis_1m: a.analysis_1m || "",
        analysis_5m: a.analysis_5m || "",
        analysis_15m: a.analysis_15m || "",
        analysis_1h: a.analysis_1h || "",
        analysis_1d: a.analysis_1d || "",
      })),
      positions: toArray(obj.positions).map((p: any) => ({
        symbol: p.symbol || "",
        action: p.action === "close" ? "close" : "hold",
        reason: p.reason || "",
        confidence: Number(p.confidence) || 0.7,
      })),
      newTrades: toArray(obj.newTrades).map((t: any) => ({
        action: ["buy","sell","hold"].includes(t.action) ? t.action : "hold",
        symbol: t.symbol || "",
        leverage: Math.min(CONFIG.maxLeverage, Math.max(1, t.leverage || CONFIG.defaultLeverage)),
        amountPercent: Math.min(100, Math.max(1, t.amountPercent || CONFIG.basePositionPct)),
        reason: t.reason || "",
        confidence: Math.min(1, Math.max(0, t.confidence || 0.5)),
        stopLossPct: t.stopLossPct || 5,
        takeProfitPct: t.takeProfitPct || 15,
      })),
      summary: obj.summary || "",
    };
  }

  const json = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  
  try {
    return buildReport(JSON.parse(json));
  } catch (e) {
    const errMsg = String(e).slice(0, 80);
    if (errMsg.includes("end") || errMsg.includes("Unexpected") || errMsg.includes("position")) {
      for (let i = json.length - 1; i > 50 && i > json.length - 300; i--) {
        try { return buildReport(JSON.parse(json.slice(0, i) + "}]}]}")); } catch {}
      }
      logger.error(`AI JSON 截断修复失败`);
    } else {
      logger.error(`AI JSON 解析失败: ${String(e).slice(0, 100)}`);
    }
    return null;
  }
}

/**
 * 投资委员会主席 — 综合策略分析, 输出最终决策
 */
export async function getMarketReport(
  strategyReport: StrategyReport,
  positions: Position[],
  account: AccountInfo,
  recentDecisions: any[],
  openTrades: any[],
): Promise<MarketReport | null> {
  const stats = getTradeStats(7);
  const prompt = buildStrategyPrompt(strategyReport, positions, account, openTrades, recentDecisions, stats);

  let raw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: CONFIG.ai.model,
        temperature: CONFIG.ai.temperature,
        max_tokens: CONFIG.ai.maxTokens,
        messages: [
          {
            role: "system",
            content: "你是加密货币投资委员会主席。你收到三个独立策略的分析报告。综合不同观点，发现矛盾，做出最终交易决策。不盲从任何单一策略。只输出JSON。"
          },
          { role: "user", content: prompt },
        ],
      });
      raw = resp.choices[0]?.message?.content || "";
      logger.info(`AI主席(${raw.length}字符): ${raw.slice(0, 120)}...`);
      if (raw.length < 500 && attempt < 2) {
        logger.warn(`⚠️ AI 响应偏短，重试 (${attempt}/2)...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      break;
    } catch (e: any) {
      logger.error(`AI 主席调用失败: ${e.message}`);
      return null;
    }
  }

  const report = parseReport(raw);
  if (report) {
    logger.info(`📊 AI主席: ${report.analysis.length}分析 | ${report.positions.length}持仓指令 | ${report.newTrades.filter(t=>t.action!=='hold').length}交易信号`);
  }
  return report;
}
