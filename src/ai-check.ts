/**
 * AI 方向复核 — 轻量级 DeepSeek 调用
 * 评分 0-100 + 持仓管理建议
 */
import { CONFIG } from "./config";
import { openai } from "./ai-client";
import { scoringAdvice } from "./state";

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
  signals: Map<string, AiOpinion>  // key = symbol:action (如 BTC/USDT:buy);
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

${scoringAdvice ? `【评分校准建议（基于近期复盘）】
${scoringAdvice}

` : ""}你的任务（输出 JSON）：
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
3. 给出整体市场偏向 market_bias（bullish/bearish/balanced）
 每个币种同时有做多和做空两个信号，需对称评估：
   - 强下行趋势：做空 > 做多
   - 强上行趋势：做多 > 做空
   - 超卖区(RSI<30+BB下轨)：做多50-70，做空降低
   - 超买区(RSI>70+BB上轨)：做空50-70，做多降低
   - 震荡或方向矛盾：两者均 ≤ 40
 评分规则（必须遵守，违反扣相应分）：
 a) 多维度冲突降分：以下≥3项同时出现 → score ≤ 40
    · RSI < 25（做多则为RSI > 75）
    · 费率方向不利（做空费率<0利多、做多费率>0利空）
    · 成交量萎缩（< 均量0.8×）
    · BB触及极端（做空下轨、做多上轨）
 b) 费率权重：不利每超0.01%扣10分，有利每超0.01%加5分
 c) 趋势尾部：底背离（价跌RSI不跌）或ADX回落10+点+量缩 → score ≤ 50
 d) 多周期矛盾：1m/5m的EMA20方向与1h/1d相反
    → 短周期已转向但大周期未反映，入场时机已过
    → 所有信号评分 ≤ 50
 4. 对整个市场行情质量给出 market_quality 0-100
  回测结果仅作参考，多周期交叉验证优先。
格式：
{"signals":[{"symbol":"BTC/USDT","action":"sell","score":85,"reason":"(回测:延续 cf80%) 费率中性 量正常"},...],
 "positions":[{"symbol":"ETH/USDT","action":"hold","reason":"趋势完好"},...],
 "market_quality":65}
reason必须含：费率方向+量状态+RSI，如有冲突项需列举。`;

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
        result.signals.set(`${r.symbol}:${r.action}`, { score: r.score ?? 50, reason: r.reason || "" });
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