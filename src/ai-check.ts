/**
 * AI 方向复核 — 轻量级 DeepSeek 调用
 * 评分 0-100 + 持仓管理建议
 */
import { CONFIG } from "./config";
import { openai } from "./ai-client";

export interface AiOpinion {
  score: number;
  reason: string;
}

export interface AiPositionSuggestion {
  symbol: string;
  action: "hold" | "close";
  reason: string;
}

export interface AiCheckResult {
  signals: Map<string, AiOpinion>;
  positions: AiPositionSuggestion[];
  marketQuality?: number;  // AI 对整体行情质量的评分 0-100
  marketBias?: "bullish" | "bearish" | "balanced";  // AI 对市场整体偏向的判断
}

export async function aiDirectionCheck(
  signals: { symbol: string; action: string; confidence: number; score: number; reason: string; regime?: string }[],
  tickerData: string,
  positionData: string,
  backtestData: string = "",
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

【实时回测评估】
${backtestData || "无回测数据"}

你的任务（输出 JSON）：
1. 对每个策略信号，给出 score 0-100 表示支持度：
   - 0-30: 不认同，跳过
   - 30-50: 认同但谨慎，建议轻仓
   - 50-70: 认同，建议半仓
   - 70-100: 强烈认同，正常开仓
2. 对每个持仓，评估是否需要平仓：
   原则：
   - 亏损≠平仓理由（只要趋势完好就应该hold）
    - 盈利收窄（峰值回吐超一半且当前仅微盈）→ close 锁利
   - 趋势确已转坏才close，需要**两个以上指标同时确认**：
     · ADX快速回落20+点
     · MACD背离严重（日线级别顶/底背离）
     · 成交量持续萎缩 + 价格停滞
     · RSI单一超买/超卖不是足够的理由
   - 其他情况 → hold
3. 给出整体市场偏向 market_bias（bullish/bearish/balanced），用于修正逆势信号
 4. 对整个市场行情质量给出 market_quality 0-100：
    - ATR在放大还是收窄？K线实体大还是小？多周期方向一致还是矛盾？
    - 高质量=趋势清晰适合交易，低质量=震荡/纠结

 特别规则 - 回测结果优先：
   - 每条信号的【实时回测评估】中有"延续"或"反转"策略标记
   - 如果回测判定为"延续"策略且该币ADX>55（极端趋势）：
     → RSI极端值（超买/超卖）不作为否决理由
     → score不应低于60
   - 如果回测判定为"反转"策略：
     → RSI极端值可作为确认信号，但需结合K线质量
   - 回测置信度>65%时，评分应尊重回测结论

格式：
{"signals":[{"symbol":"BTC/USDT","score":85,"reason":"(回测:延续 cf80%) ADX高位RSI合理, 费率中性, 量正常"},...],
 "positions":[{"symbol":"ETH/USDT","action":"hold","reason":"趋势完好"},...],
 "market_quality":65}

reason字段格式: (回测:延续/反转 cfXX%) 核心判断, 费率XX%, 量状态
例: (回测:延续 cf77%) 回踩EMA20, 费率-0.008%偏空, 量萎缩→谨慎做多
必须明确引用回测结论+费率方向+量状态, 不要省略。`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: CONFIG.ai.maxTokens,
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
        action: p.action === "close" ? "close" : "hold",
        reason: p.reason || "",
      }));
    }
    if (typeof parsed.market_quality === "number") {
      result.marketQuality = Math.max(0, Math.min(100, parsed.market_quality));
    }
    if (["bullish", "bearish", "balanced"].includes(parsed.market_bias)) {
      result.marketBias = parsed.market_bias;
    }
    return result;
  } catch {
    return result;
  }
}