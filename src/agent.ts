/**
 * SmartTrade - AI 交易决策引擎
 * 每 5 分钟输出全币种多维度分析 + 持仓管理 + 开仓决策
 */
import OpenAI from "openai";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { getTradeStats } from "./db";
import type { MarketData, Position, AccountInfo } from "./exchanges";

const openai = new OpenAI({
  apiKey: CONFIG.ai.apiKey,
  baseURL: CONFIG.ai.baseURL,
});

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
  action: "hold" | "close" | "close_partial";
  closePercent?: number;
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

type OHLCVMap = Map<string, Record<string, { open: number; high: number; low: number; close: number }[]>>;

function buildPrompt(
  tickers: Map<string, MarketData>,
  ohlcvData: OHLCVMap,
  positions: Position[],
  account: AccountInfo,
  openTrades: any[],
  recentDecisions: any[],
  stats: any
): string {
  const posLines = positions.length > 0
    ? positions.map(p => {
        const db = openTrades.find((t: any) => t.symbol === p.symbol);
        const partial = db?.partial_close_pct || 0;
        return `${p.symbol} ${p.side} | 入场:$${p.entryPrice?.toFixed(2)} | PnL:${p.unrealizedPnlPct?.toFixed(2)}% | 保证金:$${p.margin?.toFixed(2)} | 已分批:${partial}%`;
      }).join("\n")
    : "无持仓";

  // 计算关键价位的衍生数据（精简格式：直接给多周期信号）
  const coinLines: string[] = [];
  for (const sym of CONFIG.symbols) {
    const t = tickers.get(sym);
    if (!t) continue;
    const tfSignals: { tf: string; direction: string; strength: string; change: string }[] = [];

    const ohlcv = ohlcvData.get(sym);
    if (ohlcv) {
      for (const tf of ["1m", "5m", "15m", "1h", "1d"]) {
        const candles = ohlcv[tf];
        if (!candles || candles.length < 3) continue;
        const c = candles;
        const close = c[c.length-1].close;
        const openFirst = c[0].open;
        const change = ((close - openFirst) / openFirst * 100);
        // 判断多空：价格相对 MA5/MA10 的位置
        const ma5 = c.slice(-5).reduce((s,x) => s + x.close, 0) / Math.min(5, c.length);
        const ma10 = c.reduce((s,x) => s + x.close, 0) / c.length;
        const aboveMA5 = close > ma5;
        const aboveMA10 = close > ma10;
        let direction = "中性";
        let strength = "中";
        if (aboveMA5 && aboveMA10) { direction = "看涨"; strength = Math.abs(close/ma5-1) > 0.005 ? "强" : "中"; }
        else if (!aboveMA5 && !aboveMA10) { direction = "看跌"; strength = Math.abs(close/ma5-1) > 0.005 ? "强" : "中"; }
        else { direction = aboveMA5 ? "偏涨" : "偏跌"; strength = "弱"; }
        tfSignals.push({ tf, direction, strength, change: change.toFixed(1) });
      }
    }
    // 多周期共振判断
    const bullish = tfSignals.filter(s => s.direction === "看涨" || s.direction === "偏涨").length;
    const bearish = tfSignals.filter(s => s.direction === "看跌" || s.direction === "偏跌").length;
    const total = tfSignals.length;
    let alignment = "中性";
    let alignIcon = "🟡";
    if (total > 0) {
      const pct = Math.max(bullish, bearish) / total;
      if (pct >= 0.75) {
        alignment = bullish > bearish ? "多头共振" : "空头共振";
        alignIcon = bullish > bearish ? "🟢" : "🔴";
      } else if (pct >= 0.5) {
        alignment = bullish > bearish ? "偏多" : "偏空";
        alignIcon = bullish > bearish ? "🟢" : "🔴";
      } else {
        alignment = "多空矛盾";
        alignIcon = "🟡";
      }
    }
    const tfLine = tfSignals.map(s =>
      `${s.tf}:${s.direction}(${s.strength})变化${s.change}%`
    ).join(" | ");
    coinLines.push(`【${sym}】$${t.price?.toFixed(t.price>100?0:4)} | 24h:${t.change24h?.toFixed(2)}% | 费率:${(t.fundingRate || 0).toFixed(4)}% | ${alignIcon}${alignment}`);
    if (tfLine) coinLines.push(`  ${tfLine}`);
    coinLines.push("");
  }

  // 近 7 日战绩摘要
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
  // 最近 10 条 AI 决策复盘
  let decLines = "";
  if (recentDecisions && recentDecisions.length > 0) {
    decLines = "最近 AI 决策：\n" + recentDecisions.slice(0, 12).map((d: any) => {
      const st = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      return `  ${st} ${d.symbol} ${d.action} ${d.leverage}x ${d.amount}% 置信${d.confidence} | ${d.reason?.slice(0, 50)}`;
    }).join("\n");
  }

  return `你是一个经验丰富的加密货币交易员。以下是你当前看到的盘面和技术指标，请给出交易决策。

## 行情数据
${coinLines.join("\n")}

## 当前持仓（优先）
${posLines}

## 账户 | 权益:$${account.totalEquity.toFixed(2)} | 可用:$${account.availableBalance.toFixed(2)} | 杠杆上限:${CONFIG.maxLeverage}x | 仓位上限:${CONFIG.maxPositions}

## 历史战绩（近7日）
${historyLines || "无历史数据"}
${decLines ? "\n" + decLines : ""}

## 🔍 复盘反省（必须做）
你的历史战绩显示总亏损$${stats && stats.totalPnl < 0 ? Math.abs(stats.totalPnl).toFixed(2) : "0"}。请针对每笔亏损分析：
- 开仓时你的判断依据是什么？结果证明哪里错了？
- 是方向看反了，还是进场时机不对，还是止损设太宽？
- 当前市场状态和上周比有变化吗？你的策略是否需要调整？
- **多空平等**，不要死扛一个方向

## 你的任务（不是描述行情，而是做交易决策）
1. 对各币种给出评分 -10~+10 和操作建议
2. **持仓管理是第一优先级**：
   - 盈利收窄（峰值回吐超过一半）→ close 或 close_partial 锁定利润
   - 持仓亏损且无反转信号 → close 止损离场，不要一直 hold
   - 趋势衰竭（ADX回落/RSI极端/量能萎缩）→ 主动平仓，不分方向
   - 每轮至少给出 1-2 个平仓/减仓建议，不要全部 hold
3. 再找新机会：buy(做多)/sell(做空)/hold(不做)
4. 需要你超越技术指标的地方：
   - 哪些信号是**真突破**，哪些是**假动作**？
   - 各时间框架之间是**共振**还是**矛盾**？哪个更可信？
   - 当前**资金费率**和**波动率**告诉你了什么信息？
   - 哪些币种在**领涨/领跌**？资金在**轮动**吗？
   - **风险回报比**如何？值不值得入场？
5. 每轮要体现你作为交易员的**思考过程**，不要只输出数据

## JSON 格式
{
  "analysis": [
    {"symbol":"BTC/USDT","analysis_1m":"放量突破前高，真突破概率大","analysis_5m":"MA多头排列，但RSI超买","analysis_15m":"上升通道健康","analysis_1h":"接近阻力位，注意回调","analysis_1d":"宽幅震荡，未突破","trend":"bullish","strength":"moderate","keyLevels":"支撑74000 阻力78000","summary":"短线动量足但接近阻力，谨慎看多","score":6}
  ],
  "positions": [
    {"symbol":"SUI/USDT","action":"hold","reason":"趋势完好但量能减弱，盯紧止损","confidence":0.7},
    {"symbol":"DOGE/USDT","action":"close_partial","closePercent":50,"reason":"反弹测试阻力但空头未变，先减半仓降风险","confidence":0.65}
  ],
  "newTrades": [
    {"action":"sell","symbol":"SUI/USDT","leverage":5,"amountPercent":15,"reason":"空头共振，日线趋势强，追空","confidence":0.8}
  ],
  "summary": "【决策】暂不开新仓，持有ETH/SOL观察 | 理由：整体偏空但短线有反弹动能，等待日线确认"
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
        action: ["hold","close","close_partial"].includes(p.action) ? p.action : "hold",
        closePercent: p.closePercent ? Math.min(100, Math.max(1, p.closePercent)) : undefined,
        reason: p.reason || "",
        confidence: Number(p.confidence) || 0.7,
      })),
      newTrades: toArray(obj.newTrades).map((t: any) => ({
        action: ["buy","sell","hold"].includes(t.action) ? t.action : "hold",
        symbol: t.symbol || "",
        leverage: Math.min(CONFIG.maxLeverage, Math.max(1, t.leverage || CONFIG.defaultLeverage)),
        amountPercent: Math.min(100, Math.max(5, t.amountPercent || 15)),
        reason: t.reason || "",
        confidence: Math.min(1, Math.max(0, t.confidence || 0.5)),
        stopLossPct: t.stopLossPct || 5,
        takeProfitPct: t.takeProfitPct || 15,
      })),
      summary: obj.summary || "",
    };
  }

  // 提取 JSON
  const json = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  
  try {
    return buildReport(JSON.parse(json));
  } catch (e) {
    // 仅当 JSON 确实截断时才修复
    const errMsg = String(e).slice(0, 80);
    if (errMsg.includes("end") || errMsg.includes("Unexpected") || errMsg.includes("position")) {
      for (let i = json.length - 1; i > 50 && i > json.length - 300; i--) {
        try { return buildReport(JSON.parse(json.slice(0, i) + "}]}]}")); } catch {}
      }
      logger.error(`AI JSON 截断修复失败, 尝试恢复部分数据...`);
    } else {
      logger.error(`AI JSON 解析失败: ${String(e).slice(0, 100)}`);
    }
    return null;
  }
}

export async function getMarketReport(
  tickers: Map<string, MarketData>,
  ohlcvData: OHLCVMap,
  positions: Position[],
  account: AccountInfo,
  recentDecisions: any[],
  openTrades: any[],
  marketNews?: any
): Promise<MarketReport | null> {
  const stats = getTradeStats(7);
  let prompt = buildPrompt(tickers, ohlcvData, positions, account, openTrades, recentDecisions, stats);
  
  // 追加消息面
  if (marketNews) {
    let newsStr = "\n## 市场消息（最新）\n";
    if (marketNews.fearGreed) {
      const fg = marketNews.fearGreed;
      const fgLabel = fg.value <= 25 ? "极度恐惧" : fg.value <= 45 ? "恐惧" : fg.value <= 55 ? "中性" : fg.value <= 75 ? "贪婪" : "极度贪婪";
      newsStr += `恐惧贪婪指数: ${fg.value} (${fgLabel}) — ${fg.classification}\n`;
    }
    if (marketNews.headlines?.length) {
      newsStr += "头条新闻:\n" + marketNews.headlines.map((h: any) => `  - ${h.title}`).join("\n") + "\n";
    }
    // 在「历史战绩」之前插入消息
    prompt = prompt.replace("## 历史战绩", newsStr + "## 历史战绩");
  }

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
            content: "你是一个有10年经验的加密货币交易员。不要复述价格涨跌，而是给出超越技术指标的深层判断：真突破还是假动作？多周期共振还是矛盾？资金流向和风险回报比。多空平等。只输出JSON。"
          },
          { role: "user", content: prompt },
        ],
      });
      raw = resp.choices[0]?.message?.content || "";
      logger.info(`AI(${raw.length}字符): ${raw.slice(0, 120)}...`);
      if (raw.length < 2000 && attempt < 2) {
        logger.warn(`⚠️ AI 响应偏短，重试 (${attempt}/2)...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      break;
    } catch (e: any) {
      logger.error(`AI 调用失败: ${e.message}`);
      return null;
    }
  }

  const report = parseReport(raw);
  if (report) {
    logger.info(`📊 ${report.analysis.length}币种 | ${report.positions.length}持仓指令 | ${report.newTrades.filter(t=>t.action!=='hold').length}交易信号`);
  }
  return report;
}
