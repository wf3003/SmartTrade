/**
 * 止损监控器 — 独立于 AI 决策循环，每 2 秒运行
 * 
 * 检查项:
 *   1. ATR 动态止损 (趋势 4×ATR / 震荡 2×ATR)
 *   2. 时间止损 (>4h 从未盈利, 亏损 ≥ -2%)
 *   3. 无盈利平仓 (>120min 从不超过 +0.5%, 当前亏损)
 */
import { logger } from "../logger";
import { exchangeManager } from "../exchanges";
import { atrCache } from "../state";
import { checkStopLoss } from "../risk";
import { newPositionTime, recentlyClosed, recentlyOpened, getPeak } from "./shared";
import { getLatestOpenTrades } from "../db";
import { executeFullClose } from "../close-executor";

const INTERVAL_MS = 2_000;

let _timer: ReturnType<typeof setInterval> | null = null;

async function tick() {
  try {
    const positions = await exchangeManager.getPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      if (recentlyClosed.has(pos.symbol)) continue;
      if (recentlyOpened.has(pos.symbol)) continue;
      if (!pos.qty || pos.qty <= 0) continue;

      const pnlPct = pos.unrealizedPnlPct || 0;
      const peakPnl = getPeak(pos.symbol);

      const openedAt = newPositionTime.get(pos.symbol);
      const posAge = openedAt ? Date.now() - openedAt : 99999;
      const isNewPosition = posAge < 30_000;

      // --- 1. ATR 止损 ---
      if (isNewPosition) {
        if (pnlPct <= -15) {
          logger.warn(`🛑 新仓宽止损: ${pos.symbol} 亏损${pnlPct.toFixed(1)}%`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "stop_loss_new");
          continue;
        }
      } else {
        const atrVal = atrCache.get(pos.symbol) || 0.015;
        // 通过 indicatorCache 获取行情名来判断趋势/震荡
        const { indicatorCache } = await import("../state");
        const ind = indicatorCache.get(pos.symbol);
        const regimeName = ind?.regime || "unknown";
        const isTrend = regimeName.includes("趋势") || regimeName === "unknown";
        const atrMult = isTrend ? 4 : 2;
        const slResult = checkStopLoss(pnlPct, peakPnl, pos.leverage || 5, atrVal, atrMult);
        if (slResult?.shouldClose) {
          logger.warn(`🛑 ${slResult.description} | ${pos.symbol}`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, slResult.level);
          continue;
        }
      }

      // --- #6 强平预警: 清算距离<2%时自动减仓30% ---
      const liqPrice = pos.liquidationPrice || 0;
      if (liqPrice > 0 && pos.entryPrice > 0) {
        const liqDist = pos.side === "long"
          ? Math.abs((pos.entryPrice - liqPrice) / pos.entryPrice) * 100
          : Math.abs((liqPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (liqDist < 2 && liqDist > 0) {
          const reduceQty = Math.round(pos.qty * 0.3);
          if (reduceQty > 0) {
            logger.warn(`⚠️ 强平预警: ${pos.symbol} 清算距${liqDist.toFixed(1)}%<2%, 自动减仓${reduceQty}张(30%)`);
            try {
              await exchangeManager.closePosition(pos.symbol, pos.side, reduceQty);
              recentlyClosed.add(pos.symbol);
              setTimeout(() => recentlyClosed.delete(pos.symbol), 15000);
            } catch (e: any) {
              logger.error(`强平减仓失败 ${pos.symbol}: ${e.message}`);
            }
          }
        }
      }

      // --- 2. 时间止损 (>4h 从未盈利, 亏损 ≥ -2%) ---
      const posAgeHours = openedAt ? (Date.now() - openedAt) / 3_600_000 : 0;
      if (posAgeHours > 4 && pnlPct <= -2 && peakPnl <= 0) {
        logger.warn(`⏰ 时间止损: ${pos.symbol} ${posAgeHours.toFixed(1)}h从未盈利`);
        await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "time_stop");
        continue;
      }

      // --- 3. 无盈利平仓 (>120min 从未过半盈, 当前亏损) ---
      const posAgeMin = openedAt ? (Date.now() - openedAt) / 60_000 : 0;
      if (posAgeMin > 120 && pnlPct < 0 && peakPnl < 0.5) {
        logger.warn(`⏰ 无盈利平仓: ${pos.symbol} ${posAgeMin.toFixed(0)}分从未过半盈`);
        await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "no_profit_stop");
      }
    }
  } catch (e: any) {
    // 静默失败，下轮重试
  }
}

export function startStopLossMonitor() {
  if (_timer) return;
  logger.info(`🛡️ 止损监控器已启动 (每 ${INTERVAL_MS / 1000}s)`);
  tick();
  _timer = setInterval(tick, INTERVAL_MS);
}

export function stopStopLossMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
