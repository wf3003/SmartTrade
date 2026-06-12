/**
 * 止损监控器 — SuperFilter版
 * 检查 A-V2 止盈止损 + 时间止损
 */
import { logger } from "../logger";
import { exchangeManager } from "../exchanges";
import { clearTrailingStop } from "../risk/atrStop";
import { newPositionTime, recentlyClosed, recentlyOpened, av2StopPrice, av2TpPrice, av2TrailingLine, peakPnlMap } from "./shared";
import { updatePeakPnlInDb, getLatestOpenTrades } from "../db";
import { executeFullClose } from "../close-executor";

const INTERVAL_MS = 2_000;
const BACKOFF_MS = 30_000;
let _timer: ReturnType<typeof setInterval> | null = null;
let _backoff = false;

async function tick() {
  if (_backoff) return;
  try {
    const positions = await exchangeManager.getPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      if (recentlyClosed.has(pos.symbol)) continue;
      if (recentlyOpened.has(pos.symbol)) continue;
      if (!pos.qty || pos.qty <= 0) continue;

      const pnlPct = pos.unrealizedPnlPct || 0;
      const openedAt = newPositionTime.get(pos.symbol);
      const posAgeHours = openedAt ? (Date.now() - openedAt) / 3_600_000 : 0;

      const price = pos.entryPrice > 0
        ? (pos.side === "long"
          ? pos.entryPrice * (1 + pnlPct / 100 / (pos.leverage || 1))
          : pos.entryPrice * (1 - pnlPct / 100 / (pos.leverage || 1)))
        : 0;

      // 1. A-V2 止损
      const stp = av2StopPrice.get(pos.symbol);
      if (stp && price > 0) {
        if ((pos.side === "long" && price <= stp) || (pos.side === "short" && price >= stp)) {
          logger.warn(`🛑 A-V2止损: ${pos.symbol} $${price.toFixed(2)} < 止损$${stp.toFixed(2)}`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "av2_stop");
          clearTrailingStop(pos.symbol);
          av2StopPrice.delete(pos.symbol); av2TpPrice.delete(pos.symbol); av2TrailingLine.delete(pos.symbol);
          continue;
        }
        // 2. A-V2 止盈（固定盈亏比）
        const tp = av2TpPrice.get(pos.symbol);
        if (tp && ((pos.side === "long" && price >= tp) || (pos.side === "short" && price <= tp))) {
          logger.warn(`✅ A-V2止盈: ${pos.symbol} $${price.toFixed(2)} > 止盈$${tp.toFixed(2)}`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "av2_tp");
          clearTrailingStop(pos.symbol);
          av2StopPrice.delete(pos.symbol); av2TpPrice.delete(pos.symbol); av2TrailingLine.delete(pos.symbol);
          continue;
        }

        // 3. A-V2 曲线跟踪止盈（仅在盈利时触发，防亏钱出场）
        const trail = av2TrailingLine.get(pos.symbol);
        if (pnlPct > 0 && trail && trail > 0 && ((pos.side === "long" && price < trail) || (pos.side === "short" && price > trail))) {
          logger.warn(`📉 A-V2曲线止盈: ${pos.symbol} 价格$${price.toFixed(2)} 突破趋势线$${trail.toFixed(2)}`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "av2_trail_tp");
          clearTrailingStop(pos.symbol);
          av2StopPrice.delete(pos.symbol); av2TpPrice.delete(pos.symbol); av2TrailingLine.delete(pos.symbol);
          continue;
        }

        // 4. 右侧止盈：追踪峰值 PnL，回撤超过 70% 或回撤到亏损时平仓
        const peakVal = peakPnlMap.get(pos.symbol) ?? 0;
        if (pnlPct > peakVal) {
          peakPnlMap.set(pos.symbol, pnlPct);
          try {
            const dbTrade = getLatestOpenTrades().get(pos.symbol);
            if (dbTrade?.id) updatePeakPnlInDb(dbTrade.id, pnlPct);
          } catch {}
        }
        if (peakVal >= 3 && pnlPct < Math.max(peakVal * 0.3, 0)) {
          logger.warn(`⚠️ 右侧止盈: ${pos.symbol} 峰值${peakVal.toFixed(1)}%→当前${pnlPct.toFixed(1)}%`);
          await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "av2_revert_tp");
          clearTrailingStop(pos.symbol);
          av2StopPrice.delete(pos.symbol); av2TpPrice.delete(pos.symbol); av2TrailingLine.delete(pos.symbol);
          continue;
        }
      }

      // 5. 时间止损 (>4h 从未盈利, 亏损 ≥ -2%)
      if (posAgeHours > 4 && pnlPct <= -2) {
        logger.warn(`⏰ 时间止损: ${pos.symbol} ${posAgeHours.toFixed(1)}h`);
        await executeFullClose(pos.symbol, pos.side, pos.qty, 0, pnlPct, "time_stop");
        continue;
      }
    }
  } catch (e: any) {
    _backoff = true;
    logger.warn(`⚠️ getPositions 失败，暂停监控 30s: ${e?.message?.slice(0,60)}`);
    setTimeout(() => _backoff = false, BACKOFF_MS);
  }
}

export function startStopLossMonitor() {
  if (_timer) return;
  logger.info(`🛡️ SuperFilter止损监控器 (每 ${INTERVAL_MS / 1000}s)`);
  tick();
  _timer = setInterval(tick, INTERVAL_MS);
}

export function stopStopLossMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
