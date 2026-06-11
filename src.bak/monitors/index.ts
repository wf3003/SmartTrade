/**
 * 监控器统一入口 — 启动/停止所有独立监控器
 * 
 * 三个独立监控器各自运行在独立的 setInterval 上:
 *   - stopLossMonitor: ATR止损 + 时间止损 + 无盈利止损
 *   - profitMonitor:   浮盈保护 + 盈利回吐
 * 
 * 与 AI 决策循环完全解耦 —— 即使 AI 超时 30s，止损仍每 2s 触发
 */
import { logger } from "../logger";
import { getOpenPositionPeakPnlMap } from "../db";
import { peakPnlMap } from "./shared";
import { startStopLossMonitor, stopStopLossMonitor } from "./stopLossMonitor";
import { startProfitMonitor, stopProfitMonitor } from "./profitMonitor";

/** 从 DB 恢复上次运行时的峰值 PnL */
export function restorePeakPnlFromDb() {
  try {
    const saved = getOpenPositionPeakPnlMap();
    for (const [symbol, data] of saved) {
      peakPnlMap.set(symbol, data.peakPnl);
    }
    if (saved.size > 0) {
      logger.info(`📈 已从 DB 恢复 ${saved.size} 个持仓的峰值 PnL`);
    }
  } catch {}
}

export function startAllMonitors() {
  restorePeakPnlFromDb();
  startStopLossMonitor();
  startProfitMonitor();
}

export function stopAllMonitors() {
  stopStopLossMonitor();
  stopProfitMonitor();
}
