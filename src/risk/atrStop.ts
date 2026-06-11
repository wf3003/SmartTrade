/**
 * ATR 动态吊灯止损 — 价格维度的跟踪止损
 *
 * 多头：止损价 = 期间最高价 - 3×ATR，只升不降
 * 空头：止损价 = 期间最低价 + 3×ATR，只降不升
 *
 * 与 risk.ts 的 PnL% 维度止损互补，形成双保险
 */

import { atrCache, indicatorCache } from "../state";

/** 每个持仓的跟踪止损价 */
export const trailingStopPrice = new Map<string, number>();
/** 每个持仓的跟踪极值（long=最高价, short=最低价） */
export const trailingExtreme = new Map<string, number>();

export function calcChandelierStop(
  currentPrice: number,
  atr: number,
  side: "long" | "short",
  multiplier = 3,
): number {
  if (atr <= 0) return side === "long" ? currentPrice * 0.95 : currentPrice * 1.05;
  return side === "long"
    ? currentPrice - multiplier * atr
    : currentPrice + multiplier * atr;
}

export function updateTrailingStop(
  symbol: string,
  currentPrice: number,
  atrAbs: number,
  side: "long" | "short",
  multiplier = 3,
): number {
  const oldStop = trailingStopPrice.get(symbol);
  const oldExtreme = trailingExtreme.get(symbol);

  if (side === "long") {
    const newHigh = Math.max(currentPrice, oldExtreme ?? currentPrice);
    trailingExtreme.set(symbol, newHigh);
    const stopFromHigh = calcChandelierStop(newHigh, atrAbs, side, multiplier);
    const finalStop = oldStop !== undefined ? Math.max(oldStop, stopFromHigh) : stopFromHigh;
    trailingStopPrice.set(symbol, finalStop);
    return finalStop;
  } else {
    const newLow = Math.min(currentPrice, oldExtreme ?? currentPrice);
    trailingExtreme.set(symbol, newLow);
    const stopFromLow = calcChandelierStop(newLow, atrAbs, side, multiplier);
    const finalStop = oldStop !== undefined ? Math.min(oldStop, stopFromLow) : stopFromLow;
    trailingStopPrice.set(symbol, finalStop);
    return finalStop;
  }
}

export function isChandelierTriggered(
  currentPrice: number,
  side: "long" | "short",
  symbol: string,
): boolean {
  const stop = trailingStopPrice.get(symbol);
  if (stop === undefined) return false;
  return side === "long" ? currentPrice <= stop : currentPrice >= stop;
}

export function clearTrailingStop(symbol: string): void {
  trailingStopPrice.delete(symbol);
  trailingExtreme.delete(symbol);
}

export function getAtrAbs(symbol: string, price: number): number {
  return (atrCache.get(symbol) ?? 0.015) * price;
}

export function getRegimeMultiplier(symbol: string): number {
  const regime = (indicatorCache.get(symbol)?.regime) || "unknown";
  return regime.includes("趋势") ? 4 : 2;
}
