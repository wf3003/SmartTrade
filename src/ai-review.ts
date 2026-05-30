/**
 * AI 交易复盘 — 定时分析历史交易，深度输出改进建议
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { openai } from "./ai-client";

export async function aiTradeReview(
  tradeSummary: string,
  symbolStats: string,
  strategyConfig: string,
): Promise<string> {
  if (!tradeSummary) return "";

  const prompt = `你是一个加密货币交易策略分析师。以下是系统的近期交易记录和策略配置。

【策略配置】
${strategyConfig}

【逐笔交易明细】
${tradeSummary}

【按币种分组统计】
${symbolStats}

请以 JSON 格式输出分析：
{
  "summary": "一句话总结近期表现",
  "winners": [{"signal":"信号类型","reason":"为什么赚钱"}],
  "losers": [{"signal":"信号类型","reason":"为什么亏"}],
  "bySymbol": [{"symbol":"BTC/USDT","analysis":"表现分析"}],
  "suggestions": ["具体优化建议"],
  "blockSignals": "哪些信号应该禁止？为什么？",
  "blockSymbols": ["BCH/USDT", "SUI/USDT"]
}`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: CONFIG.ai.maxTokens,
      response_format: { type: "json_object" },
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    if (text === "{}" || text.length < 20) {
      logger.warn(`[复盘] AI 返回过短: ${text.slice(0, 100)}`);
      return "";
    }
    const parsed = JSON.parse(text);
    if (parsed.summary || parsed.winners || parsed.losers || parsed.suggestions) {
      return JSON.stringify(parsed, null, 2);
    }
    logger.warn(`[复盘] AI 返回缺关键字段: ${text.slice(0, 200)}`);
    return "";
  } catch (e: any) {
    logger.warn(`[复盘] 异常: ${e.message?.slice(0, 200)}`);
    return "";
  }
}

export function buildTradeSummary(trades: any[]): string {
  if (!trades || trades.length === 0) return "";
  // 取最近30笔，防42笔以上交易导致提示词+输出超出token限制
  const recent = trades.slice(-30);
  return recent.map((t: any) => {
    const pnl = t.pnl || 0;
    const e = pnl >= 0 ? "✅" : "❌";
    const peak = t.peak_pnl_pct ? `峰值${t.peak_pnl_pct.toFixed(1)}%` : "";
    const reason = (t.reason||"").slice(0,80);
    return `${e} ${t.symbol} ${t.side} ${t.leverage}x | 盈亏:$${pnl.toFixed(2)} (${(t.pnl_pct||0).toFixed(1)}%) ${peak} | ${t.close_type||""} | ${reason}`;
  }).join("\n");
}

export function buildSymbolStats(trades: any[]): string {
  if (!trades) return "";
  const map: Record<string, {pnl:number; w:number; l:number; ct:string[]}> = {};
  for (const t of trades) {
    if (t.status !== "closed") continue;
    const s = t.symbol;
    if (!map[s]) map[s] = {pnl:0, w:0, l:0, ct:[]};
    map[s].pnl += t.pnl||0;
    (t.pnl||0) >= 0 ? map[s].w++ : map[s].l++;
    if (t.close_type) map[s].ct.push(t.close_type);
  }
  return Object.entries(map).map(([sym, s]) => {
    const t = s.w+s.l, wr = t>0?(s.w/t*100).toFixed(0):"0";
    return `${sym}: ${s.w}胜${s.l}负(${wr}%) 净盈亏:$${s.pnl.toFixed(2)} | 出场:${[...new Set(s.ct)].join(",")}`;
  }).join("\n");
}
