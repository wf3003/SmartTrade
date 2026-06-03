/**
 * SmartTrade - AI 交易决策引擎
 * 每 5 分钟输出全币种多维度分析 + 持仓管理 + 开仓决策
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { getTradeStats, getPartialClosePct } from "./db";
import { openai } from "./ai-client";
import { calcIndicators, convertCandles, calcMACD } from "./indicators";
import type { MarketData, Position, AccountInfo } from "./exchanges";

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

type OHLCVMap = Map<string, Record<string, { open: number; high: number; low: number; close: number; volume?: number }[]>>;

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
        const partial = db ? getPartialClosePct(db.id as number, db.entry_qty as number) : 0;
        const liqDist = p.liquidationPrice && p.entryPrice
          ? Math.abs((p.liquidationPrice - p.entryPrice) / p.entryPrice * 100 / (p.leverage || 1)).toFixed(1)
          : '?';
        return `${p.symbol} ${p.side} | 入场:$${p.entryPrice?.toFixed(2)} | PnL:${p.unrealizedPnlPct?.toFixed(2)}% | 清算距:${liqDist}% | 保证金:$${p.margin?.toFixed(2)} | 杠杆:${p.leverage}x${partial > 0 ? ` | 已分批:${partial}%` : ''}`;
      }).join("\n")
    : "无持仓";

  // 每个币种发完整技术指标（ADX/RSI/ATR/EMA/BB/量/MACD），取代旧MA5/MA10判断
  const coinLines: string[] = [];
  for (const sym of CONFIG.symbols) {
    const t = tickers.get(sym);
    if (!t) continue;
    const ohlcv = ohlcvData.get(sym);
    const tfOut: string[] = [];
    for (const tf of ["1m", "5m", "15m", "1h", "1d"]) {
      const raw = ohlcv?.[tf];
      if (!raw || raw.length < 8) continue;
      const arr = convertCandles(raw);
      const ind = calcIndicators(arr);
      if (!ind) continue;
      const price = arr[arr.length - 1][4];
      const openFirst = arr[0][4];
      const volArr = arr.map(x => x[5]);
      const lastVol = volArr[volArr.length - 1];
      const avgVol = ind.volumeAvg || 1;
      const volRatio = lastVol / avgVol;
      const chg = ((price - openFirst) / openFirst * 100);
      const ema20Dev = ((price - ind.ema20) / ind.ema20 * 100);
      const ema50Dev = ((price - ind.ema50) / ind.ema50 * 100);
      const bbPos = ind.bbUpper > ind.bbLower
        ? ((price - ind.bbLower) / (ind.bbUpper - ind.bbLower) * 100) : 50;
      // ADX/RSI 标签
      const adxSuf = ind.adx >= 75 ? '*' : ind.adx < 25 ? '~' : '';
      const rsiSuf = (ind.rsi14 <= 30 || ind.rsi14 >= 70) ? '!' : '';
      // 成交量标签
      let volStr = `${volRatio.toFixed(1)}×(平)`;
      if (volRatio < 0.8) volStr = `${volRatio.toFixed(1)}×(缩)`;
      else if (volRatio > 1.2) volStr = `${volRatio.toFixed(1)}×(放量${chg >= 0 ? '↑' : '↓'})`;
      // BB 位置
      let bbStr = '';
      if (bbPos <= 25) bbStr = `BB下(${bbPos.toFixed(0)}%)`;
      else if (bbPos >= 75) bbStr = `BB上(${bbPos.toFixed(0)}%)`;
      // MACD (仅 1h 和 1d)
      let macdStr = '';
      if (tf === '1h' || tf === '1d') {
        const closes = arr.map(x => x[4]);
        const m = calcMACD(closes);
        if (m.signal !== "数据不足") macdStr = `MACD:${m.signal}`;
      }
      const emaArrow = ema20Dev >= 0 ? '↑' : '↓';
      // 组装一行
      const parts = [
        `ADX${ind.adx.toFixed(0)}${adxSuf}`,
        `RSI${ind.rsi14.toFixed(0)}${rsiSuf}`,
        `ATR${(ind.atr14 / price * 100).toFixed(2)}%`,
        `EMA20${emaArrow}${Math.abs(ema20Dev).toFixed(2)}%`,
        volStr,
      ];
      if (bbStr) parts.push(bbStr);
      if (macdStr) parts.push(macdStr);
      if (tf === '1d') parts.push(`EMA50${emaArrow}${Math.abs(ema50Dev).toFixed(2)}%`);
      const chgStr = (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%';
      tfOut.push(`${tf}:${chgStr} ${parts.join(' ')}`);
    }
    const fr = t.fundingRate ?? 0;
    const frSentiment = fr > 0.005 ? '多拥挤' : fr < -0.005 ? '空拥挤' : '中性';
    coinLines.push(`【${sym}】$${t.price?.toFixed(t.price>100?0:4)} | 24h:${t.change24h?.toFixed(2)}% | 费率:${(fr).toFixed(4)}%(${frSentiment})`);
    if (tfOut.length > 0) {
      for (const line of tfOut) coinLines.push(`  ${line}`);
    } else {
      coinLines.push(`  数据不足`);
    }
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
你的历史战绩显示总盈亏${(stats && stats.totalPnl) ? `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}` : "$0"}。请分析：
- **近期亏损单的共同特征是什么**？方向？入场时机？止损位置？
- 当前市场状态和之前比有变化吗？你的策略是否需要调整？
- **多空平等**，不要死扛一个方向
- 你对持仓管理的判断准确吗？该平没平还是不该平平早了？

## 你的任务（不是描述行情，而是做交易决策）
你拿到了每个币种5个时间框架(1m/5m/15m/1h/1d)的完整指标：
- **ADX**: 趋势强度，*号=极强趋势(≥75)，~号=弱趋势/震荡(<25)
- **RSI**: 超买超卖，!号=极端值(≤30或≥70)
- **ATR%**: 波动率，止损设ATR的1.5-2倍
- **EMA20↑↓X%**: 价格相对EMA20的偏离，↑=在上方(偏多)，↓=在下方(偏空)
- **量**: 最新成交量相对均量，缩=缩量，放量↑/↓=放量涨/跌（确认信号）
- **BB上/下(%)**: 价格在Bollinger Band中的位置
- **MACD**: 金叉/死叉/顶背离/底背离（仅1h和1d）
- **费率**: (+)多拥挤=多军在付钱(-)空拥挤=空军在付钱，极端值预示反转

分析要求：
1. **多周期交叉验证** — 哪些周期方向一致（共振）？哪些矛盾？哪个更可信？
   - 日线强趋势但小周期已转向 → 可能趋势衰竭，谨慎追单
   - 小周期放量突破+大周期支持 → 真突破概率高
   - 日线触及BB下轨+RSI超卖 → 反弹风险高
2. **持仓管理是第一优先级**：
   - 盈利收窄（峰值回吐超过一半）→ close 锁定利润
   - 持仓亏损且无反转信号 → close 止损离场，不要一直 hold
   - 趋势衰竭（ADX回落/RSI极端/量能萎缩）→ 主动平仓，不分方向
   - **每轮必须给出至少 1-2 个平仓建议**，不要全部 hold
3. 再找新机会：buy(做多)/sell(做空)/hold(不做)
4. 你的评分 -10~+10 要体现：
   - 多周期共振情况
   - 量价配合程度
   - 风险回报比
   - 与当前市场主方向的偏离
5. 每轮要体现你作为交易员的**思考过程**，不要只输出数据

## JSON 格式
{
  "analysis": [
    {"symbol":"BTC/USDT","analysis_1m":"ADX65 RSI42 放量跌，空头主导","analysis_5m":"ADX72 RSI38 量平，空头延续","analysis_15m":"ADX68 RSI35 缩量，下跌动能减弱","analysis_1h":"ADX80 RSI32 触及BB下轨，趋势极强但超卖","analysis_1d":"ADX75 RSI29 超卖区，回调风险高","trend":"bearish","strength":"strong","keyLevels":"支撑64500 阻力67500","summary":"日线强空但RSI超卖+BB下轨，短线有反弹可能，追空风险大，等反弹再空","score":-5}
  ],
  "positions": [
    {"symbol":"SUI/USDT","action":"hold","reason":"浮亏但日线ADX65仍在空头，收紧止损观察","confidence":0.65},
    {"symbol":"DOGE/USDT","action":"close","reason":"15m/1h方向矛盾，缩量反弹后可能转跌，先平仓观察","confidence":0.7}
  ],
  "newTrades": [
    {"action":"sell","symbol":"AAVE/USDT","leverage":3,"amountPercent":10,"reason":"日线空+1h放量跌+费率中性，等1h反弹EMA20再空","confidence":0.7}
  ],
  "summary": "【决策】整体偏空但多个币种RSI进入超卖区，追空风险增大。持仓3个继续hold观察，DOGE量能不足准备平仓。新仓等反弹再入，不追。"
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
