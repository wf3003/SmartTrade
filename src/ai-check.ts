/**
 * AI 方向复核 — 轻量级 DeepSeek 调用
 * 仅判断策略的技术指标方向是否合理，不替代整个策略
 */
import OpenAI from "openai";
import { CONFIG } from "./config";

const openai = new OpenAI({
  apiKey: CONFIG.ai.apiKey,
  baseURL: CONFIG.ai.baseURL,
});

export async function aiDirectionCheck(
  signals: { symbol: string; action: string; confidence: number; score: number; reason: string }[],
  tickerSummary: string,
): Promise<Map<string, "agree" | "disagree" | "neutral">> {
  if (signals.length === 0) return new Map();

  const signalLines = signals.map(t =>
    `${t.symbol} → ${t.action} (信心${(t.confidence * 100).toFixed(0)}%, 评分${t.score}) | ${t.reason}`
  ).join("\n");

  const prompt = `你是一个加密货币交易方向审核员。技术指标策略给出了以下开仓信号，请判断方向是否合理。

当前行情概要：${tickerSummary}

策略信号：
${signalLines}

你的任务：对每个信号判断 direction（agree/disagree/neutral），只基于当前市场状况，不要给操作建议。

格式 JSON：
{"results": [{"symbol":"BTC/USDT","direction":"agree"}, ...]}`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1000,
      response_format: { type: "json_object" },
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);
    const results = new Map<string, "agree" | "disagree" | "neutral">();
    if (parsed.results) {
      for (const r of parsed.results) {
        results.set(r.symbol, r.direction || "neutral");
      }
    }
    return results;
  } catch {
    return new Map(); // AI 挂了就放行
  }
}
