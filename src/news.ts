import { logger } from "./logger";
let cachedFng: any = null, cachedNews: any[] = [], lastFetch = 0;
export async function getMarketNews() {
  const now = Date.now();
  if (now - lastFetch < 600000 && cachedFng) return { fearGreed: cachedFng, headlines: cachedNews };
  let fng: any = null;
  let news: any[] = [];
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(8000) });
    const j = await r.json() as any;
    const d = j?.data?.[0];
    if (d) fng = { value: Number(d.value), classification: d.value_classification };
  } catch {}
  try {
    const r = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN&feeds=coindesk,cointelegraph&extraParams=QuantMax", { signal: AbortSignal.timeout(8000) });
    const j = await r.json() as any;
    news = (j?.Data || []).slice(0, 5).map((h: any) => ({ title: h.title, source: h.source }));
  } catch {}
  if (fng) cachedFng = fng;
  if (news.length > 0) cachedNews = news;
  lastFetch = now;
  if (fng || news.length > 0) logger.info(`📰 消息: 恐惧贪婪${fng?.value||"?"}(${fng?.classification||"无"}) 头条${news.length}条`);
  return { fearGreed: fng, headlines: news };
}
