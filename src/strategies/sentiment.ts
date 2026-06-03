/**
 * 策略2: 资金面/情绪分析
 * 输入: MarketData, funding rates, volume, 市场质量
 * 输出: 多空拥挤度 + 资金流向 + 情绪偏向 + 置信度
 */
import type { MarketData } from "../exchanges";
import { calcMarketQuality } from "../indicators";

export interface SentimentAnalysis {
  symbol: string;
  /** 情绪方向 */
  sentimentBias: "bullish" | "bearish" | "neutral";
  /** 置信度 0-100 */
  confidence: number;
  /** AI prompt 用的自然语言分析 */
  analysis: string;
  /** 费率拥挤信号 */
  fundingSignal: string;
  /** 成交量异常信号 */
  volumeSignal: string;
  /** 市场质量 0-100 */
  marketQuality: number;
}

/**
 * 资金面/情绪分析策略
 * 
 * 核心维度:
 * 1. 费率方向 — 多空拥挤的领先指标
 *    费率>0.01% = 多头拥挤(偏空信号)
 *    费率<-0.01% = 空头拥挤(偏多信号)
 * 2. 成交量验证 — 放量确认方向,缩量警告衰竭
 * 3. 行情质量 — 综合评分(ATR趋势 + K线质量 + 多周期一致性)
 */
export function analyzeSentiment(
  ticker: MarketData,
  ohlcv: Record<string, any[]>,
  symbol: string,
): SentimentAnalysis {
  const fr = ticker.fundingRate ?? 0;
  const frPct = fr * 100;
  const price = ticker.price;

  // 1. 费率分析
  let fundingSignal: string;
  let frScore = 0; // 正=偏空, 负=偏多
  if (fr > 0.0005) {
    const mag = Math.round(frPct * 100);
    fundingSignal = `多头拥挤(费率+${frPct.toFixed(3)}%)`;
    frScore = Math.min(5, 1 + mag / 10);
  } else if (fr < -0.0005) {
    const mag = Math.round(Math.abs(frPct) * 100);
    fundingSignal = `空头拥挤(费率${frPct.toFixed(3)}%)`;
    frScore = -Math.min(5, 1 + mag / 10);
  } else if (fr > 0.0001) {
    fundingSignal = `略偏多(费率+${frPct.toFixed(3)}%)`;
    frScore = 0.5;
  } else if (fr < -0.0001) {
    fundingSignal = `略偏空(费率${frPct.toFixed(3)}%)`;
    frScore = -0.5;
  } else {
    fundingSignal = `中性(费率${frPct.toFixed(3)}%)`;
    frScore = 0;
  }

  // 2. 成交量验证
  const volume24h = ticker.volume24h ?? 0;
  const change24h = ticker.change24h ?? 0;

  let volumeSignal: string;
  let volScore = 0;
  if (volume24h > 50_000_000 && Math.abs(change24h) > 3) {
    volumeSignal = `巨量${change24h >= 0 ? "拉升" : "砸盘"}(${(volume24h / 1e6).toFixed(0)}M)`;
    volScore = 2;
  } else if (volume24h > 10_000_000 && Math.abs(change24h) > 2) {
    volumeSignal = `放量${change24h >= 0 ? "涨" : "跌"}(${(volume24h / 1e6).toFixed(0)}M)`;
    volScore = 1;
  } else if (volume24h < 1_000_000) {
    volumeSignal = `低量(${(volume24h / 1e3).toFixed(0)}K) 流动性差`;
    volScore = 0;
  } else {
    volumeSignal = `正常(${(volume24h / 1e6).toFixed(1)}M)`;
    volScore = 0.5;
  }

  // 3. 市场质量
  const raw1h = ohlcv["1h"] || [];
  const raw15m = ohlcv["15m"] || [];
  const raw5m = ohlcv["5m"] || [];

  // 转换 candles 格式
  const toArr = (raw: any[]) => raw.map((c: any) => [
    0, c.open ?? 0, c.high ?? 0, c.low ?? 0, c.close ?? 0, c.volume ?? 0,
  ] as number[]);

  const mq = raw1h.length >= 6
    ? calcMarketQuality(toArr(raw1h), toArr(raw15m), toArr(raw5m), fr)
    : 30;

  let mqLabel: string;
  if (mq >= 70) mqLabel = "优质";
  else if (mq >= 50) mqLabel = "良好";
  else if (mq >= 30) mqLabel = "一般";
  else if (mq >= 15) mqLabel = "较差";
  else mqLabel = "差";

  // 4. 情绪方向综合
  // 费率信号: frScore正=偏空(多头拥挤→空方向), frScore负=偏多(空头拥挤→多方向)
  // 成交量信号: 带方向的量能确认
  // 行情质量: 低质量市场方向信号不可靠

  let sentimentBias: "bullish" | "bearish" | "neutral";
  let conf = 50;

  // frScore 正 = 多头拥挤 → 偏空
  // frScore 负 = 空头拥挤 → 偏多
  if (Math.abs(frScore) >= 2) {
    sentimentBias = frScore > 0 ? "bearish" : "bullish";
    conf = 55 + Math.abs(frScore) * 5;
  } else if (Math.abs(frScore) >= 0.5) {
    sentimentBias = frScore > 0 ? "bearish" : "bullish";
    conf = 45 + Math.abs(frScore) * 5;
  } else {
    sentimentBias = "neutral";
    conf = 40;
  }

  // 成交量确认或削弱
  if (volume24h > 10_000_000 && Math.abs(change24h) > 3) {
    // 量大 + 方向明确 → 可能是趋势延续, 拥挤度的反转信号减弱
    if (sentimentBias === "bearish" && change24h > 5) {
      // 多头拥挤但巨量拉升 → 可能真突破, 降低反转置信度
      conf -= 15;
    } else if (sentimentBias === "bullish" && change24h < -5) {
      conf -= 15;
    }
  }

  // 行情质量修正
  if (mq < 20) conf -= 20;
  else if (mq < 40) conf -= 10;
  else if (mq >= 70) conf += 5;

  conf = Math.max(10, Math.min(85, Math.round(conf)));

  // 组装分析文本
  const analysis = [
    `【资金面】${symbol} 情绪:${sentimentBias} 置信:${conf}% 质量:${mq}(${mqLabel})`,
    `费率: ${fundingSignal} | 24h量: ${volumeSignal} | 24h涨跌: ${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`,
    mq < 30 ? `⚠ 行情质量偏低(mq${mq}), 信号可靠性下降` : "",
    Math.abs(frScore) >= 2
      ? `⚠ ${frScore > 0 ? "多头拥挤→反转风险" : "空头拥挤→反弹风险"}`
      : "",
  ].filter(Boolean).join("\n");

  return {
    symbol,
    sentimentBias,
    confidence: conf,
    analysis,
    fundingSignal,
    volumeSignal,
    marketQuality: mq,
  };
}
