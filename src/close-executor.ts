/**
 * 统一平仓执行器 — 供 AI 决策循环和独立监控器共用
 * 
 * 从 index.ts 抽取，保证无论谁触发平仓，DB 记录和状态跟踪完全一致。
 */
import { logger } from "./logger";
import { exchangeManager } from "./exchanges";
import { db, getLatestOpenTrades, closeTrade, updateSnapshotResult, updatePeakPnlInDb } from "./db";
import { peakPnlMap, partialCloseMap, recentlyClosed } from "./monitors/shared";

// ---- 方向连败跟踪 (原 index.ts directionLoss) ----
export const directionLoss = new Map<string, { count: number; blockUntil: number }>();
export const DIRECTION_BLOCK_CYCLES = 12;

// ---- 追仓频率限制 (原 index.ts chaseWindow) ----
export const chaseWindow = new Map<string, number>();

// ---- 快照关联 ----
export const snapshotIdMap = new Map<string, number>();

// ---- 本会话已开仓 (防重复) ----
export const openedThisSession = new Set<string>();

/** AI 决策周期号 (用于方向阻断倒计时) */
export let aiCycleNumber = 0;
export function setAiCycleNumber(n: number) { aiCycleNumber = n; }

export async function executeFullClose(
  symbol: string,
  side: "long" | "short",
  qty: number,
  pnl: number,
  pnlPct: number,
  closeType: string,
): Promise<{ closeResult: any; actualPnl: number; actualPnlPct: number }> {
  // 平仓前重新拉一次持仓，拿到最新快照盈亏
  let snapPnl = pnl, snapPnlPct = pnlPct;
  try {
    const positions = await exchangeManager.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (pos) { snapPnl = pos.unrealizedPnl || 0; snapPnlPct = pos.unrealizedPnlPct || 0; }
  } catch {}

  const closeResult = await exchangeManager.closePosition(symbol, side, qty);
  const dbTrade = getLatestOpenTrades().get(symbol);
  const exitPrice = closeResult.avgPrice || 0;

  let actualPnl = snapPnl, actualPnlPct = snapPnlPct;
  let pnlSource = "snap";

  // 模拟盘快照不准：用 exit_price 和 entry_price 计算兜底（含合约乘数）
  if (exitPrice > 0 && dbTrade && dbTrade.entry_price > 0) {
    const cs = symbol.includes("USDT") || symbol.includes("USD")
      ? exchangeManager.getContractSize(symbol) : 1;
    const calcPnl = side === "long"
      ? (exitPrice - dbTrade.entry_price) * qty * cs
      : (dbTrade.entry_price - exitPrice) * qty * cs;
    actualPnl = parseFloat(calcPnl.toFixed(2));
    actualPnlPct = dbTrade.margin > 0 ? (actualPnl / dbTrade.margin) * 100 : 0;
    pnlSource = "calc";
  }

  // 尝试从交易所收盘订单获取实际盈亏
  try {
    if (closeResult.order?.id) {
      const found = (exchangeManager as any).findSwapClient?.(symbol);
      if (found) {
        const closedOrders = await (found.client as any).fetchClosedOrders(found.swapSymbol, undefined, 10);
        const myOrder = closedOrders.find((o: any) => o.id === closeResult.order.id);
        if (myOrder && myOrder.info?.pnl && parseFloat(myOrder.info.pnl) !== 0) {
          actualPnl = parseFloat(myOrder.info.pnl);
          pnlSource = "exch";
          if (dbTrade && dbTrade.margin > 0) actualPnlPct = (actualPnl / dbTrade.margin) * 100;
        }
      }
    }
  } catch {}

  const pnlTag = pnlSource === "exch" ? "🧾" : "📷";
  logger.warn(`  ${pnlTag} ${symbol} src=${pnlSource} pnl=$${actualPnl.toFixed(2)} pct=${actualPnlPct.toFixed(2)}%`);

  if (dbTrade) {
    closeTrade(dbTrade.id, exitPrice, qty, actualPnl, actualPnlPct, closeResult.fee || 0, `${closeType}[${pnlSource}]`);
    // 级联关闭所有追仓子记录
    const children = db.prepare(
      "SELECT id, entry_qty, entry_price, margin FROM trades WHERE parent_id=? AND status='open' AND close_type='partial_open'"
    ).all(dbTrade.id) as any[];
    if (children.length > 0) {
      const now = new Date().toISOString();
      for (const child of children) {
        const childPnl = side === "long"
          ? (exitPrice - child.entry_price) * child.entry_qty
          : (child.entry_price - exitPrice) * child.entry_qty;
        const childPnlPct = child.margin > 0 ? (childPnl / child.margin) * 100 : 0;
        db.prepare(
          "UPDATE trades SET status='closed', close_type=?, exit_time=?, exit_price=?, pnl=?, pnl_pct=? WHERE id=?"
        ).run(`${closeType}[${pnlSource}]`, now, exitPrice,
          parseFloat(childPnl.toFixed(2)), parseFloat(childPnlPct.toFixed(2)), child.id);
      }
      logger.warn(`  🧹 ${symbol} 级联关闭 ${children.length} 条追仓子记录`);
    }
    // 更新 indicator_snapshot
    const snapId = snapshotIdMap.get(symbol);
    if (snapId) {
      updateSnapshotResult(snapId, actualPnl >= 0 ? "win" : "loss", actualPnl, `${closeType}[${pnlSource}]`);
    }
    db.prepare("UPDATE indicator_snapshots SET result = ?, pnl = ?, close_type = ? WHERE trade_id = ? AND result = 'open'")
      .run(actualPnl >= 0 ? "win" : "loss", actualPnl, `${closeType}[${pnlSource}]`, dbTrade.id);
  }

  // 状态清理
  peakPnlMap.delete(symbol);
  partialCloseMap.delete(symbol);
  openedThisSession.delete(symbol);

  // 方向连败跟踪
  const dirKey = `${symbol}:${side}`;
  if (actualPnlPct <= 0) {
    const cur = directionLoss.get(dirKey) || { count: 0, blockUntil: 0 };
    cur.count++;
    if (cur.count >= 3) {
      cur.blockUntil = aiCycleNumber + DIRECTION_BLOCK_CYCLES;
      logger.warn(`🚫 ${dirKey} 连败${cur.count}次 → 屏蔽${DIRECTION_BLOCK_CYCLES}周期`);
    }
    directionLoss.set(dirKey, cur);
  } else {
    directionLoss.delete(dirKey);
  }

  // 追仓计数衰减
  const chaseResetKey = `${symbol}:${side}`;
  chaseWindow.delete(chaseResetKey);

  // 标记为最近关闭，防止监控同步误重建
  recentlyClosed.add(symbol);
  setTimeout(() => recentlyClosed.delete(symbol), 30_000);

  return { closeResult, actualPnl, actualPnlPct };
}
