/**
 * QuantMax - 风控模块
 * 账户级 + 持仓级 + 分批止盈
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { exchangeManager, type MarketData, type Position, type AccountInfo } from "./exchanges";
import { db, updatePartialClose, closeTrade, getTradesToday } from "./db";

// 账户峰值追踪（用于回撤检查）
let peakEquity = 0;
// 当日累计亏损追踪
let dailyLoss = 0;
let dailyLossDate = "";

// 已触发的分批止盈阶段（持仓级跟踪）
const partialTPTriggered = new Map<number, Set<string>>();

export interface RiskCheck {
  allowOpen: boolean;
  reason?: string;
  accountStop: boolean;
}

/** 更新账户峰值（在 monitorPositions 中每轮调用） */
export function updatePeakEquity(equity: number) {
  if (equity > peakEquity) peakEquity = equity;
}

// ========== 账户级风控 ==========
export function checkAccountRisk(account: AccountInfo, livePositions: number = 0): RiskCheck {
  if (account.totalEquity <= CONFIG.accountStopLossUsdt) {
    return { allowOpen: false, reason: `账户权益 $${account.totalEquity.toFixed(0)} ≤ 止损线 $${CONFIG.accountStopLossUsdt}`, accountStop: true };
  }
  if (account.totalEquity >= CONFIG.accountTakeProfitUsdt) {
    return { allowOpen: false, reason: `账户权益 $${account.totalEquity.toFixed(0)} ≥ 止盈线 $${CONFIG.accountTakeProfitUsdt}`, accountStop: true };
  }
  if (account.marginRatio > 80) {
    return { allowOpen: false, reason: `保证金率 ${account.marginRatio.toFixed(1)}% 过高`, accountStop: false };
  }
  // 回辙检查
  if (peakEquity > 0 && CONFIG.maxDrawdownPercent > 0) {
    const drawdown = (peakEquity - account.totalEquity) / peakEquity * 100;
    if (drawdown > CONFIG.maxDrawdownPercent) {
      return { allowOpen: false, reason: `账户回撤 ${drawdown.toFixed(1)}% ≥ 上限 ${CONFIG.maxDrawdownPercent}%，禁止开仓`, accountStop: false };
    }
  }
  // 当日累计亏损检查
  const today = new Date().toISOString().slice(0, 10);
  if (dailyLossDate !== today) { dailyLoss = 0; dailyLossDate = today; }
  // 从 DB 统计今天的已实现亏损
  const todayTrades = getTradesToday() as any[];
  const realized = todayTrades.filter((t: any) => t.status === "closed").reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  dailyLoss = Math.min(dailyLoss, realized);
  if (dailyLoss <= -CONFIG.dailyLossLimitUsdt) {
    return { allowOpen: false, reason: `当日累计亏损 $${Math.abs(dailyLoss).toFixed(0)} ≥ 上限 $${CONFIG.dailyLossLimitUsdt}，暂停交易`, accountStop: false };
  }

  // 用交易所实时持仓数（防止 DB 幽灵记录误判）
  if (livePositions >= CONFIG.maxPositions) {
    return { allowOpen: false, reason: `持仓数 ${livePositions} ≥ 上限 ${CONFIG.maxPositions}`, accountStop: false };
  }
  return { allowOpen: true, accountStop: false };
}

// ========== 分批止盈检查 ==========
export interface PartialTPResult {
  shouldClose: boolean;
  closePercent: number;
  stage: string;
  description: string;
}

export function checkPartialTakeProfit(
  positionId: number,
  currentPnlPct: number,
  alreadyClosedPct: number
): PartialTPResult | null {
  const { stage1, stage2, stage3 } = CONFIG.partialTP;

  const stages = [
    { name: "stage1", trigger: stage1.trigger, closePercent: stage1.closePercent },
    { name: "stage2", trigger: stage2.trigger, closePercent: stage2.closePercent },
    { name: "stage3", trigger: stage3.trigger, closePercent: stage3.closePercent },
  ];

  for (const stage of stages) {
    if (currentPnlPct >= stage.trigger) {
      if (alreadyClosedPct < stage.closePercent) {
        const thisClosePct = stage.closePercent - alreadyClosedPct;
        return {
          shouldClose: true,
          closePercent: thisClosePct,
          stage: stage.name,
          description: `分批止盈 ${stage.name}: 盈利${currentPnlPct.toFixed(1)}% ≥ ${stage.trigger}%, 平仓${thisClosePct}% (累计${stage.closePercent}%)`,
        };
      }
    }
  }
  return null;
}

// ========== 分批止盈执行 ==========
export async function executePartialClose(
  positionId: number,
  symbol: string,
  side: "long" | "short",
  totalQty: number,
  closePercent: number,
  entryPrice: number,
  currentPrice: number,
  leverage: number
): Promise<boolean> {
  let closeQty = Math.floor(totalQty * closePercent / 100);
  if (closeQty <= 0) closeQty = Math.min(1, totalQty);

  try {
    const closeResult = await exchangeManager.closePosition(symbol, side, closeQty);

    const priceDiff = currentPrice - entryPrice;
    const dir = side === "long" ? 1 : -1;
    const pnl = priceDiff * closeQty * dir;
    const pnlPct = entryPrice > 0 ? (priceDiff / entryPrice * 100 * leverage * dir) : 0;

    logger.warn(`🔒 分批止盈 | ${symbol} ${side} | 平 ${closeQty}/${totalQty} 张 | PnL: $${pnl.toFixed(2)}`);

    // 更新数据库中的 partial_close_pct
    const current = (db.prepare("SELECT partial_close_pct FROM trades WHERE id = ?").get(positionId) as any)?.partial_close_pct || 0;
    const newPct = current + closePercent;
    updatePartialClose(positionId, newPct, closeQty, pnl);

    // 如果完全平仓（累计 100%），关闭记录
    if (newPct >= 100) {
      const closeFee = closeResult.fee || 0;
      closeTrade(positionId, currentPrice, totalQty, pnl, pnlPct, closeFee, "partial_tp");
    }

    return true;
  } catch (e: any) {
    logger.error(`分批止盈失败 ${symbol}: ${e.message}`);
    return false;
  }
}

// ========== 获取当前价格 ==========
export async function getCurrentPrice(symbol: string): Promise<number> {
  const ticker = await exchangeManager.getTicker(symbol);
  return ticker?.price || 0;
}

// ========== 计算 PnL% (考虑杠杆) ==========
export function calcPnlPct(entryPrice: number, currentPrice: number, side: "long" | "short", leverage: number): number {
  if (entryPrice <= 0) return 0;
  const pct = (currentPrice - entryPrice) / entryPrice * 100;
  return pct * leverage * (side === "long" ? 1 : -1);
}

// ========== 止损检查（从峰值回撤） ==========
export interface StopLossResult {
  shouldClose: boolean;
  level: string;
  description: string;
}

/**
 * 检查是否触发止损
 * 规则: 
 *   - 盈利 >= 30%时，回撤到 20% 以下 → 平仓（锁利）
 *   - 盈利 >= 20%且 <30%时，回撤到 10% 以下 → 平仓
 *   - 盈利 >= 10%且 <20%时，回撤到 5% 以下 → 平仓
 *   - 盈利 < 10%时，回撤到 0%（即亏到入场价）→ 平仓
 *   - 亏损达到 -5% → 强制平仓
 */
export function checkStopLoss(
  currentPnlPct: number,
  peakPnlPct: number
): StopLossResult | null {
  // 统一止损：亏损 ≥ -8%（6x杠杆下价格约反向1.3%）就平仓
  if (currentPnlPct <= -8) {
    return { shouldClose: true, level: "stop_loss", description: `亏损${currentPnlPct.toFixed(1)}% 触发止损` };
  }
  return null;
}

/**
 * 执行止损平仓（从交易所直接平）
 */
export async function executeStopLoss(
  closeFn: () => Promise<void>,
  symbol: string,
  qty: number
): Promise<boolean> {
  try {
    await closeFn();
    logger.warn(`🛑 止损平仓: ${symbol} ${qty}张`);
    return true;
  } catch (e: any) {
    logger.error(`止损平仓失败 ${symbol}: ${e.message}`);
    return false;
  }
}
