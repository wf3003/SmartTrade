/**
 * AI 交易复盘 — 定时分析历史交易，输出改进建议
 */
import OpenAI from "openai";
import { CONFIG } from "./config";

const openai = new OpenAI({
  apiKey: CONFIG.ai.apiKey,
  baseURL: CONFIG.ai.baseURL,
});

export async function aiTradeReview(
  tradeSummary: string,
  decisionStats: string,
  strategyConfig: string,
): Promise<string> {
  if (!tradeSummary) return "";

  const prompt = `你是一个加密货币交易策略分析师。以下是系统的近期交易记录和策略配置。

【策略配置】
${strategyConfig}

【近期交易】
${tradeSummary}

【决策统计】
${decisionStats}

请以 JSON 格式输出你的分析：
{
  "summary": "一句话总结近期表现",
  "winners": ["胜率高的信号类型"],
  "losers": ["亏损的信号类型"],
  "suggestions": ["具体优化建议"],
  "paramsChange": {"建议改的参数": "建议新值"}
}`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);
    return parsed.summary ? JSON.stringify(parsed, null, 2) : "";
  } catch {
    return "";
  }
}

/** 构建交易摘要供 AI 分析 */
export function buildTradeSummary(trades: any[]): string {
  if (!trades || trades.length === 0) return "无交易";
  const closed = trades.filter((t: any) => t.status === "closed");
  const lines: string[] = [];
  for (const t of closed) {
    const pnl = t.pnl || 0;
    const emoji = pnl >= 0 ? "✅" : "❌";
    lines.push(`${emoji} ${t.symbol} ${t.side} ${t.leverage}x | PnL:$${pnl.toFixed(2)} (${(t.pnl_pct||0).toFixed(1)}%) | ${t.close_type || ""} | ${(t.reason||"").slice(0, 60)}`);
  }
  return lines.join("\n");
}
