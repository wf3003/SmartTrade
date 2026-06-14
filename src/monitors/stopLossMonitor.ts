/**
 * 统一止损止盈监控器 — 每 2 秒运行
 *
 * 规则（简化版）：
 *   止损：PnL ≤ -5% → 立即平仓
 *   移动止盈：
 *     - 盈利峰值 < 5%：从峰值回撤 2.5% 平仓（例：峰值3% → 跌到0.5%平仓）
 *     - 盈利峰值 ≥ 5%：从峰值回撤 5% 平仓（例：峰值15% → 跌到10%平仓）
 */
import { logger } from "../logger";
import { exchangeManager } from "../exchanges";
import { recentlyClosed, recentlyOpened, peakPnlMap, updatePeak } from "./shared";
import { executeFullClose } from "../close-executor";

const INTERVAL_MS = 2_000;
const BACKOFF_MS = 30_000;

// 止损线：PnL 百分比
const STOP_LOSS_PCT = -5;

// 移动止盈参数
const TRAIL_MIN_PEAK = 3;    // 峰值 < 3% 不触发移动止盈，让利润跑
const TRAIL_DD_PCT = 0.6;    // 峰值 < 11%：回撤 60%（保留 40%）
const TRAIL_THRESHOLD = 11;  // 分界线
const TRAIL_LARGE_DD = 5;    // 峰值 ≥ 11%：回撤 5%

let _timer: ReturnType<typeof setInterval> | null = null;
let _backoff = false;

async function tick() {
  if (_backoff) return;
  try {
    const positions = await exchangeManager.getPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      const symbol = pos.symbol;
      if (recentlyClosed.has(symbol)) continue;
      if (recentlyOpened.has(symbol)) continue;
      if (!pos.qty || pos.qty <= 0) continue;

      const pnlPct = pos.unrealizedPnlPct || 0;

      // ── 更新峰值 ──
      updatePeak(symbol, pnlPct);
      const currentPeak = peakPnlMap.get(symbol) ?? pnlPct;

      // ── 止损：PnL ≤ -5% ──
      if (pnlPct <= STOP_LOSS_PCT) {
        logger.warn(`🛑 止损: ${symbol} PnL=${pnlPct.toFixed(1)}% ≤ ${STOP_LOSS_PCT}%`);
        try {
          await executeFullClose(symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pnlPct, "stop_loss");
          peakPnlMap.delete(symbol);
        } catch (e: any) {
          logger.warn(`🛑 止损 ${symbol} 平仓失败: ${e.message?.slice(0, 80)}`);
        }
        continue;
      }

      // ── 移动止盈 ──
      if (currentPeak >= TRAIL_MIN_PEAK) {
        // 峰值 < 11%：回撤 60%（例：10% → 4%出）；峰值 ≥ 11%：回撤 5%（例：15% → 10%出）
        const exitLine = currentPeak < TRAIL_THRESHOLD
          ? currentPeak * (1 - TRAIL_DD_PCT)
          : currentPeak - TRAIL_LARGE_DD;

        if (pnlPct <= exitLine) {
          logger.warn(`📈 移动止盈: ${symbol} 峰值${currentPeak.toFixed(1)}%→当前${pnlPct.toFixed(1)}% ≤ 平仓线${exitLine.toFixed(1)}%`);
          try {
            await executeFullClose(symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pnlPct, "trail_tp");
            peakPnlMap.delete(symbol);
          } catch (e: any) {
            logger.warn(`📈 移动止盈 ${symbol} 平仓失败: ${e.message?.slice(0, 80)}`);
          }
          continue;
        }
      }
    }
  } catch (e: any) {
    _backoff = true;
    logger.warn(`⚠️ getPositions 失败，暂停监控 30s: ${e?.message?.slice(0, 60)}`);
    setTimeout(() => (_backoff = false), BACKOFF_MS);
  }
}

export function startStopLossMonitor() {
  if (_timer) return;
  logger.info(`🛡️ 止损止盈监控器 (止损${STOP_LOSS_PCT}% / 移动止盈:峰值<${TRAIL_THRESHOLD}%回撤${TRAIL_DD_PCT*100}% 峰值≥${TRAIL_THRESHOLD}%回撤${TRAIL_LARGE_DD}%)`);
  tick();
  _timer = setInterval(tick, INTERVAL_MS);
}

export function stopStopLossMonitor() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
