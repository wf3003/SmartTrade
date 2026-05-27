/**
 * QuantMax - 共享状态
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
