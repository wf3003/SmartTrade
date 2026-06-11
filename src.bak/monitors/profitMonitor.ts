/**
 * 止盈/盈利保护监控器 — 独立于 AI 决策循环，每 2 秒运行
 * 
 * 检查项:
 *   1. 峰值 PnL 追踪 + 持久化
 *   2. 浮盈保护 (peak>3%, 回撤触发平仓)
 *   3. 盈利回吐全平 (peak≥5%, 回撤到亏损)
 */
import { logger } from "../logger";
import { exchangeManager } from "../exchanges";
import { atrCache } from "../state";
import { checkProfitProtect } from "../risk";
import { recentlyClosed, recentlyOpened, updatePeak, getPeak } from "./shared";
import { executeFullClose } from "../close-executor";

const INTERVAL_MS = 2_000;

let _timer: ReturnType<typeof setInterval> | null = null;

async function tick() {
  try {
    const positions = await exchangeManager.getPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      const symbol = pos.symbol;
      if (recentlyClosed.has(symbol)) continue;
      if (recentlyOpened.has(symbol)) continue;
      if (!pos.qty || pos.qty <= 0) continue;

      const pnlPct = pos.unrealizedPnlPct || 0;

      // --- 1. 追踪并持久化峰值 ---
      const { getLatestOpenTrades } = await import("../db");
      const openTrades = getLatestOpenTrades();
      const dbTrade = openTrades.get(symbol);
      updatePeak(symbol, pnlPct, dbTrade?.id);
      const peakPnl = getPeak(symbol);
      if (peakPnl <= 0) continue;

      // --- 2. 浮盈保护 ---
      const posAtr = (atrCache.get(symbol) || 0.015) * 100;
      const posLev = pos.leverage || 1;
      const protect = checkProfitProtect(peakPnl, pnlPct, posAtr, posLev);
      if (protect?.shouldClose) {
        logger.warn(`🔒 ${protect.reason} | ${symbol}`);
        await executeFullClose(symbol, pos.side, pos.qty, 0, pnlPct, "profit_protect");
        continue;
      }

      // --- 3. 盈利回吐全平 (峰值≥5%, 回撤到亏损) ---
      const trailLev = Math.max(posLev, 1);
      const peakPrice = peakPnl / trailLev;
      if (peakPrice >= 5 && pnlPct < 0) {
        logger.warn(`⚠️ 盈利回吐: ${symbol} 峰值${peakPrice.toFixed(1)}%→当前${pnlPct.toFixed(1)}%`);
        await executeFullClose(symbol, pos.side, pos.qty, 0, pnlPct, "profit_revert");
      }
    }
  } catch (e: any) {
    // 静默失败
  }
}

export function startProfitMonitor() {
  if (_timer) return;
  logger.info(`💰 止盈监控器已启动 (每 ${INTERVAL_MS / 1000}s)`);
  tick();
  _timer = setInterval(tick, INTERVAL_MS);
}

export function stopProfitMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
