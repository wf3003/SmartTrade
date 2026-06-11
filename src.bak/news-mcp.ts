/**
 * SmartTrade — 消息面数据客户端
 *
 * 从 nof1.ai 的 Gate MCP News 方案移植而来，去 VoltAgent 依赖。
 * 提供：恐惧贪婪指数 + 币种快讯 + 情绪评分，注入 AI 决策 prompt。
 *
 * 数据源：
 *   1. Alternative.me Fear & Greed Index（大盘情绪）
 *   2. CryptoCompare News（头条快讯，含 sentiment）
 *   3. Gate MCP News API（可选，需设置 GATE_NEWS_MCP_URL）
 */

import { logger } from "./logger";

// ======================= 类型 =======================

export interface NewsItem {
  title: string;
  time: string;
  sentiment: "pos" | "neu" | "neg" | "unknown";
  score: number;
  source: string;
}

export interface SymbolNews {
  symbol: string;
  items: NewsItem[];
  sentimentSummary: { pos: number; neu: number; neg: number; direction: string };
}

export interface MarketNewsReport {
  fearGreed: { value: number; classification: string } | null;
  headlines: { title: string; source: string; sentiment?: string }[];
  symbolNews: Map<string, SymbolNews>;
  summary: string;
}

// ======================= 缓存 =======================

let cachedReport: MarketNewsReport | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5分钟缓存

// ======================= Fear & Greed =======================

async function fetchFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as any;
    const d = j?.data?.[0];
    if (d) return { value: Number(d.value), classification: d.value_classification };
  } catch {}
  return null;
}

// ======================= CryptoCompare 头条 =======================

/** 
 * 从 Google News RSS 获取加密新闻（不需要 API key）
 * 返回最多 5 条头条
 */
async function fetchCryptoNewsHeadlines(): Promise<{ title: string; source: string }[]> {
  try {
    // Google News RSS: 搜索 bitcoin + crypto 关键词
    const r = await fetch(
      "https://news.google.com/rss/search?q=bitcoin+crypto+ether&hl=en-US&gl=US&ceid=US:en",
      { signal: AbortSignal.timeout(10000) },
    );
    const xml = await r.text();
    // 简单 XML 解析：提取 <title> 标签，跳过 RSS 标题行
    const titles: string[] = [];
    const regex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const t = (match[1] || match[2] || "").trim();
      if (t && !t.includes("Google News") && !t.includes("bitcoin + crypto")) {
        titles.push(t);
      }
    }
    return titles.slice(0, 5).map(t => ({ title: t, source: "Google News" }));
  } catch {}
  // 兜底：用 Fear & Greed 的简短描述
  try {
    const fng = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(5000) });
    const fj = await fng.json() as any;
    const d = fj?.data?.[0];
    if (d) return [{ title: `恐惧贪婪指数: ${d.value}/100 (${d.value_classification})`, source: "Alternative" }];
  } catch {}
  return [];
}

// ======================= Gate MCP News（可选） =======================

/**
 * 如果配置了 GATE_NEWS_MCP_URL，尝试从 Gate MCP News 拉取币种快讯。
 * MCP 使用 JSON-RPC 协议，这里做最简实现。
 */
async function fetchGateMCPNews(symbols: string[]): Promise<Map<string, SymbolNews>> {
  const result = new Map<string, SymbolNews>();
  const mcpUrl = process.env.GATE_NEWS_MCP_URL;
  if (!mcpUrl) return result;

  for (const sym of symbols) {
    try {
      const coin = sym.split("/")[0]; // BTC/USDT → BTC
      const r = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "getCryptoNews", arguments: { coin, limit: 5 } },
          id: 1,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as any;
      const content = j?.result?.content;
      if (!content) continue;
      const textItem = Array.isArray(content)
        ? content.find((c: any) => c.type === "text")
        : null;
      const data = textItem ? JSON.parse(textItem.text) : j?.result?.structuredContent;
      if (!data?.items) continue;

      const items: NewsItem[] = (data.items as any[]).map((item: any) => ({
        title: item?.metadata?.title || item?.title || "",
        time: item?.metadata?.create_time || item?.create_time || "",
        sentiment: item?.metadata?.labels?.sentiment || "unknown",
        score: item?.metadata?.total_score || 0,
        source: "GateMCP",
      }));

      const pos = items.filter(i => i.sentiment === "pos").length;
      const neg = items.filter(i => i.sentiment === "neg").length;
      const neu = items.filter(i => i.sentiment === "neu").length;
      let direction = "neutral";
      if (pos > neg * 2) direction = "bullish";
      else if (neg > pos * 2) direction = "bearish";

      result.set(sym, {
        symbol: sym,
        items: items.slice(0, 5),
        sentimentSummary: { pos, neu, neg, direction },
      });
    } catch {
      // 单个币种失败不影响其他
    }
  }
  return result;
}

// ======================= 汇总入口 =======================

export async function getMarketNewsReport(symbols: string[]): Promise<MarketNewsReport> {
  const now = Date.now();
  if (cachedReport && now - lastFetchTime < CACHE_TTL_MS) return cachedReport;

  const [fearGreed, headlines, symbolNews] = await Promise.all([
    fetchFearGreed(),
    fetchCryptoNewsHeadlines(),
    fetchGateMCPNews(symbols),
  ]);

  // 构建汇总文本
  const parts: string[] = [];
  if (fearGreed) {
    parts.push(`恐惧贪婪指数: ${fearGreed.value} (${fearGreed.classification})`);
  }
  if (headlines.length > 0) {
    parts.push(`\n头条快讯 (${headlines.length}条):`);
    for (const h of headlines.slice(0, 5)) {
      parts.push(`  · ${h.title} [${h.source}]`);
    }
  }
  if (symbolNews.size > 0) {
    parts.push(`\n币种快讯情绪:`);
    for (const [sym, sn] of symbolNews) {
      const { pos, neg, direction } = sn.sentimentSummary;
      const emoji = direction === "bullish" ? "🟢" : direction === "bearish" ? "🔴" : "⚪";
      parts.push(`  ${emoji} ${sym}: 利好${pos} 利空${neg} (${direction})`);
    }
  }

  const report: MarketNewsReport = {
    fearGreed,
    headlines,
    symbolNews,
    summary: parts.join("\n"),
  };

  cachedReport = report;
  lastFetchTime = now;

  if (fearGreed || headlines.length > 0 || symbolNews.size > 0) {
    logger.info(
      `📰 消息: 恐惧贪婪${fearGreed?.value || "?"}(${fearGreed?.classification || "无"}) ` +
      `头条${headlines.length}条 MCP快讯${symbolNews.size}币种`,
    );
  }

  return report;
}

/** 强制刷新缓存（AI 复盘时调用） */
/** 新闻熔断检测: 检查头条中是否含重大事件关键词 */
const MAJOR_EVENT_KEYWORDS = [
  "CPI", "非农", "非农就业", "FOMC", "美联储", "利率决议",
  "fed rate", "interest rate", "Payrolls", "NFP",
  "鲍威尔", "Powell", "Biden", "关税", "tariff",
  "就业数据", "通胀数据", "consumer price",
];

export function hasMajorEvent(headlines: { title: string; source: string }[]): { 
  detected: boolean; 
  events: string[] 
} {
  const events: string[] = [];
  for (const h of headlines) {
    const title = h.title || "";
    const lower = title.toLowerCase();
    for (const kw of MAJOR_EVENT_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        events.push(kw);
        break;
      }
    }
  }
  // 去重
  const unique = [...new Set(events)];
  return { detected: unique.length >= 2 || unique.some(k => k.length > 3), events: unique };
}

export function invalidateNewsCache() {
  cachedReport = null;
  lastFetchTime = 0;
}
