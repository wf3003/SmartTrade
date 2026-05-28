/**
 * SmartTrade - 共享状态
 */
export let latestReport: any = null;
export function setLatestReport(report: any) {
  latestReport = report;
}

/** 各币种 1h ATR% 缓存（策略周期计算 → 监控周期使用） */
export const atrCache = new Map<string, number>();
export function setAtrCache(symbol: string, atrPct: number) {
  atrCache.set(symbol, atrPct);
}

/** 上次获取的交易所账户/持仓数据（status 接口缓存） */
export let cachedPositions: any[] = [];
export let cachedAccount: any = {};
export function setCacheData(account: any, positions: any[]) {
  cachedAccount = account; cachedPositions = positions;
}

/** 各币种 1h RSI 缓存 */
export const rsiCache = new Map<string, number>();
export function setRsiCache(symbol: string, rsi: number) {
  rsiCache.set(symbol, rsi);
}
