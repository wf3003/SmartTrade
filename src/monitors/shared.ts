/**
 * 监控器共享状态
 * 从 index.ts 移出，供各独立监控器使用
 */
import { updatePeakPnlInDb } from "../db";

/** 各币种持仓峰值 PnL% */
export const peakPnlMap = new Map<string, number>();

/** 各币种部分平仓累计比例 */
export const partialCloseMap = new Map<string, number>();

/** 各币种开仓时间 (ms timestamp) */
export const newPositionTime = new Map<string, number>();

/** 最近平仓的币种 (30s 内，防 sync 误重建) */
export const recentlyClosed = new Set<string>();

/** 最近开仓/追仓的币种 (15s 内，防监控抢占) */
export const recentlyOpened = new Set<string>();

/** 极端偏离最后告警时间 (防刷屏) */
export let lastExtremeWarnTs: Map<string, number> | undefined;

/** 持久化峰值 PnL 到 DB */
export function updatePeak(symbol: string, pnlPct: number, dbTradeId?: number) {
  const prev = peakPnlMap.get(symbol);
  if (prev === undefined || pnlPct > prev) {
    peakPnlMap.set(symbol, pnlPct);
    if (dbTradeId) updatePeakPnlInDb(dbTradeId, pnlPct);
  }
}

/** 获取峰值 */
export function getPeak(symbol: string): number {
  return peakPnlMap.get(symbol) ?? 0;
}

/** 清理币种的所有状态 */
export function clearSymbolState(symbol: string) {
  peakPnlMap.delete(symbol);
  partialCloseMap.delete(symbol);
}
