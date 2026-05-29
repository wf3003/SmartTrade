/**
 * AI 方向复核 — 轻量级 DeepSeek 调用
 * 评分 0-100 + 持仓管理建议
 */
import OpenAI from "openai";
import { CONFIG } from "./config";

// DeepSeek 直连不走代理（代理只给交易所用）
const _saved = process.env.HTTPS_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
const openai = new OpenAI({
  apiKey: CONFIG.ai.apiKey,
  baseURL: CONFIG.ai.baseURL,
});
process.env.HTTPS_PROXY = _saved;

export interface AiOpinion {
  score: number;
  reason: string;
}

export interface AiPositionSuggestion {
  symbol: string;
  action: "hold" | "close" | "close_partial";
  closePercent?: number;
  reason: string;
}

export interface AiCheckResult {
  signals: Map<string, AiOpinion>;
  positions: AiPositionSuggestion[];
  marketQuality?: number;  // AI 对整体行情质量的评分 0-100
}

export async function aiDirectionCheck(
  signals: { symbol: string; action: string; confidence: number; score: number; reason: string; regime?: string }[],
  tickerData: string,
  positionData: string,
): Promise<AiCheckResult> {
  const result: AiCheckResult = { signals: new Map(), positions: [] };
  if (signals.length === 0 && !positionData) return result;

  const signalLines = signals.length > 0
    ? signals.map(t =>
        `${t.symbol} 策略→${t.action} (信心${(t.confidence * 100).toFixed(0)}%, 评分${t.score}) ${t.reason || ""} ${t.regime || ""}`
      ).join("\n")
    : "无";

  const prompt = `你是一个加密货币风控审核员。以下是当前市场数据、持仓和策略信号。

【市场数据】
${tickerData}

【当前持仓】
${positionData || "无"}

【策略信号】
${signalLines}

你的任务（输出 JSON）：
1. 对每个策略信号，给出 score 0-100 表示支持度：
   - 0-40: 不认同，跳过
   - 40-70: 认同但谨慎，建议半仓
   - 70-100: 强烈认同，正常开仓
2. 对每个持仓，评估是否需要主动平仓（趋势反转/不利信号）
3. 对整个市场行情质量给出 market_quality 0-100：
   - ATR在放大还是收窄？K线实体大还是小？多周期方向一致还是矛盾？
   - 高质量=趋势清晰适合交易，低质量=震荡/纠结

格式：
{"signals":[{"symbol":"BTC/USDT","score":85,"reason":"ADX高位RSI合理"},...],
 "positions":[{"symbol":"ETH/USDT","action":"hold","reason":"趋势完好"},...],
 "market_quality":65}`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);
    if (parsed.signals) {
      for (const r of parsed.signals) {
        result.signals.set(r.symbol, { score: r.score ?? 50, reason: r.reason || "" });
      }
    }
    if (parsed.positions) {
      result.positions = parsed.positions.map((p: any) => ({
        symbol: p.symbol,
        action: p.action || "hold",
        closePercent: p.closePercent,
        reason: p.reason || "",
      }));
    }
    if (typeof parsed.market_quality === "number") {
      result.marketQuality = Math.max(0, Math.min(100, parsed.market_quality));
    }
    return result;
  } catch {
    return result;
  }
}