/**
 * AI 自驱策略 — 精准移植 ds/deepseek_ok_带指标plus版本.py
 */
import { CONFIG } from "../config";
import { logger } from "../logger";
import { openai } from "../ai-client";

export interface AiTradeSignal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  stopLoss: number;
  takeProfit: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
}

// ─── 指标: 与 Python 版完全一致 ───

function sma(arr: number[], p: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) { r.push(NaN); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j];
    r.push(s / p);
  }
  return r;
}

function ema(arr: number[], span: number): number[] {
  const r: number[] = []; const k = 2 / (span + 1);
  // 第一个值用 SMA 做初始
  let s = 0; for (let i = 0; i < span; i++) s += arr[i];
  let e = s / span; r.push(e);
  for (let i = span; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); r.push(e); }
  return r;
}

function rsi(arr: number[], p: number): number[] {
  const r: number[] = new Array(arr.length).fill(NaN);
  const changes: number[] = [];
  for (let i = 1; i < arr.length; i++) changes.push(arr[i] - arr[i - 1]);
  if (changes.length < p) return r;
  let gains = 0, losses = 0;
  for (let i = 0; i < p; i++) { const d = changes[i]; gains += d > 0 ? d : 0; losses += d < 0 ? -d : 0; }
  let avgG = gains / p, avgL = losses / p;
  r[p] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = p; i < changes.length; i++) {
    const d = changes[i]; avgG = (avgG * (p - 1) + (d > 0 ? d : 0)) / p; avgL = (avgL * (p - 1) + (d < 0 ? -d : 0)) / p;
    r[i + 1] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return r;
}

function stddev(arr: number[], p: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) { r.push(NaN); continue; }
    const slice = arr.slice(i - p + 1, i + 1); const m = slice.reduce((a, b) => a + b, 0) / p;
    r.push(Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / p));
  }
  return r;
}

// ─── AI 决策 ───

export async function aiSignalDecision(
  symbol: string, tfData: Record<string, any[]>, fundingRate: number,
): Promise<AiTradeSignal | null> {
  const tf = tfData["15m"] || tfData["5m"];
  if (!tf || tf.length < 50) { logger.debug(symbol + " 数据不足"); return null; }

  // 提取 OHLCV
  const closes = tf.map((c: any) => c.close ?? c[4]);
  const highs = tf.map((c: any) => c.high ?? c[2]);
  const lows = tf.map((c: any) => c.low ?? c[3]);
  const opens = tf.map((c: any) => c.open ?? c[1]);
  const vols = tf.map((c: any) => c.volume ?? c[5]);
  const n = closes.length;
  const price = closes[n - 1];

  // 指标（与 Python 版对应）
  const sma5 = sma(closes, 5); const sma20 = sma(closes, 20); const sma50 = sma(closes, 50);
  const ema12 = ema(closes, 12); const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const macdSignal = ema(macdLine.slice(26), 9);
  const macdLine2 = macdLine.slice(26); // align length
  const rsiVals = rsi(closes, 14);
  const bbMid = sma(closes, 20); const bbStd = stddev(closes, 20);
  const bbUpper = bbMid.map((v, i) => v + 2 * (bbStd[i] || 0));
  const bbLower = bbMid.map((v, i) => v - 2 * (bbStd[i] || 0));
  const volMA = sma(vols, 20);

  // 取最新值
  const lastSma5 = sma5[n - 1]; const lastSma20 = sma20[n - 1]; const lastSma50 = sma50[n - 1];
  const lastRsi = rsiVals[n - 1];
  const lastMacd = macdLine2.length > 0 ? macdLine2[macdLine2.length - 1] : 0;
  const lastMacdSignal = macdSignal.length > 0 ? macdSignal[macdSignal.length - 1] : 0;
  const lastBbMid = bbMid[n - 1]; const lastBbUpper = bbUpper[n - 1]; const lastBbLower = bbLower[n - 1];
  const lastVol = vols[n - 1]; const lastVolMA = volMA[n - 1];
  const bbPos = (lastBbUpper - lastBbLower) > 0 ? (price - lastBbLower) / (lastBbUpper - lastBbLower) : 0.5;
  const volRatio = lastVolMA > 0 ? lastVol / lastVolMA : 1;

  // K线文本（最近5根）
  const last5 = closes.slice(-5).map((p, i) => {
    const idx = n - 5 + i; const dir = p >= opens[idx] ? "阳" : "阴";
    return "K" + (i + 1) + ":" + dir + " 开$" + opens[idx].toFixed(0) + " 收$" + p.toFixed(0);
  }).join("\n");

  const trend = price > lastSma5 && lastSma5 > lastSma20 && lastSma20 > lastSma50 ? "上涨" :
                price < lastSma5 && lastSma5 < lastSma20 && lastSma20 < lastSma50 ? "下跌" : "震荡";

  const prompt = [
    "分析 " + symbol + " 15m 行情，判断入场机会",
    "",
    "K线最后5根:",
    last5,
    "",
    "指标:",
    "SMA5: $" + lastSma5.toFixed(0) + "(" + (price > lastSma5 ? "上" : "下") + ")",
    "SMA20: $" + lastSma20.toFixed(0) + "(" + (price > lastSma20 ? "上" : "下") + ")",
    "SMA50: $" + lastSma50.toFixed(0) + "(" + (price > lastSma50 ? "上" : "下") + ")",
    "趋势: " + trend,
    "RSI(14): " + lastRsi.toFixed(1),
    "MACD: " + (lastMacd > lastMacdSignal ? "多头(金叉)" : "空头(死叉)"),
    "BB位置: " + (bbPos * 100).toFixed(0) + "%",
    "量比: " + volRatio.toFixed(2) + "x",
    "资金费率: " + (fundingRate * 100).toFixed(3) + "%",
    "",
    "规则: 趋势明确做方向/RSI>70不追多<30不追空/量比>1.5可信/费率>0.05%不追多<-0.05%不追空",
    "",
    "输出JSON（reason写具体技术依据，无方向也要写原因）:",
    '{"signal":"BUY|SELL|HOLD","reason":"...","stopLoss":数字,"takeProfit":数字,"confidence":"HIGH|MEDIUM|LOW"}',
  ].join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model as string,
      messages: [
        { role: "system", content: "你是加密货币短线交易分析师。根据用户提供的行情数据和规则，输出严格JSON：{\"signal\":\"BUY|SELL|HOLD\",\"reason\":\"...\",\"stopLoss\":数字,\"takeProfit\":数字,\"confidence\":\"HIGH|MEDIUM|LOW\"}" },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    });
    const text = resp.choices?.[0]?.message?.content || "";
    let clean = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    if (s === -1 || e === -1) { logger.warn(symbol + " 无JSON: " + text.slice(0, 80)); return null; }
    let p: any;
    try { p = JSON.parse(clean.slice(s, e + 1)); }
    catch { p = JSON.parse(clean.slice(s, e + 1).replace(/'/g, '"').replace(/([{\,])\s*(\w+)\s*:/g, '$1"$2":')); }
    if (!["buy", "sell", "hold"].includes((p.signal || "").toLowerCase())) return null;
    return {
      symbol, action: p.signal.toLowerCase() as any,
      stopLoss: p.stopLoss || price * 0.98,
      takeProfit: p.takeProfit || price * 1.02,
      confidence: p.confidence || "MEDIUM",
      reason: p.reason || "",
    };
  } catch (e: any) { logger.error(symbol + " AI异常: " + e.message); return null; }
}
