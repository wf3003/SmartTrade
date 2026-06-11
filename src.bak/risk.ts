/**
 * SmartTrade - 风控模块
 * 账户级 + 持仓级 + 分批止盈
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { exchangeManager, type AccountInfo } from "./exchanges";
import { getTradesToday } from "./db";
import { interceptParamsCache } from "./state";

// 账户峰值追踪（用于回撤检查）
let peakEquity = 0;
// 当日累计亏损追踪
let dailyLoss = 0;
let dailyLossDate = "";

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
  // 启动初期账户数据未就绪，不触发风控
  if (account.totalEquity <= 0) {
    return { allowOpen: false, reason: "账户数据未就绪", accountStop: false };
  }
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
 * 检查浮盈保护：峰值浮盈>3%后回撤过半 → 平仓锁利
 * 防止浮盈转亏（分析显示两账号共26笔浮盈>0.8%最终亏损）
 */
export function checkProfitProtect(
  peakPnlPct: number,
  currentPnlPct: number,
  atrPct: number = 0,
  leverage: number = 1,
): { shouldClose: boolean; reason: string } | null {
  if (peakPnlPct < 3 || currentPnlPct <= 0 || peakPnlPct <= 0) return null;

  // ATR跟踪止盈：trail = peak - (atr% × 杠杆 × trail_mult), 至少要保峰值的10%
  const trailMult = (interceptParamsCache.get("trail_pnl_atr_mult") ?? 150) / 100;
  let trailDist = atrPct > 0 && leverage > 1
    ? Math.max(atrPct * leverage * trailMult, peakPnlPct * 0.1)
    : peakPnlPct * 0.3;
  // 盈利>=6%时按比例给回撤空间，不再一刀切3个点
  if (peakPnlPct >= 15) {
    trailDist = Math.max(trailDist, peakPnlPct * 0.40, 4);
  } else if (peakPnlPct >= 10) {
    trailDist = Math.max(trailDist, peakPnlPct * 0.35, 3);
  } else if (peakPnlPct >= 6) {
    trailDist = Math.max(trailDist, peakPnlPct * 0.25, 2);
  }
  const trailLine = peakPnlPct - trailDist;

  // 阶梯式回撤保护：峰值越高，保护越紧（防59%→14%式大幅回吐）
  // 放宽小峰值保护，避免过早触发（如AAVE +4.9%→0触发离场）
  let protectRatio: number;
  if (peakPnlPct > 50) {
    protectRatio = 0.60; // 峰值>50%→保留60%，最多回撤40%
  } else if (peakPnlPct > 30) {
    protectRatio = 0.50; // 峰值>30%→保留50%
  } else if (peakPnlPct > 15) {
    protectRatio = 0.35; // 峰值>15%→保留35%
  } else {
    protectRatio = 0.45; // 峰值≤15%→保留45%（防微盈回吐）
  }
  const fullPct = (interceptParamsCache.get("profit_protect_retrace_pct") ?? 30) / 100;
  // 小峰值回撤下限：避免 protectRatio 过于宽松时净值回吐
  const minLine = (interceptParamsCache.get("profit_protect_min_line") ?? 0.5);
  const fullLine = Math.max(peakPnlPct * Math.max(protectRatio, fullPct), minLine);

  // 硬回撤上限：无论峰值多高，最多回撤 N 个百分点（优先保留盈利）
  const maxRetracePp = (interceptParamsCache.get("profit_protect_max_retrace_pp") ?? 5);
  const absoluteLine = peakPnlPct - maxRetracePp;

  // 取最紧的线：ATR 跟踪 vs 阶梯回撤 vs 硬回撤，谁先触发用谁
  const useLine = Math.max(trailLine, fullLine, absoluteLine);

  if (currentPnlPct < useLine) {
    return {
      shouldClose: true,
      reason: `跟踪止盈: 峰值${peakPnlPct.toFixed(1)}%→当前${currentPnlPct.toFixed(1)}%,跌破${useLine.toFixed(1)}%(ATR:${trailLine.toFixed(1)}% / 固定:${fullLine.toFixed(1)}%)`,
    };
  }
  return null;
}

/**
 * 检查是否触发止损（ATR 动态止损，分行情：趋势中 4×，震荡中 2×）
 * 止损触发价格波动 = atrMult × ATR%，乘以杠杆后得到 PnL% 阈值
 * 关键修正：之前没有乘以杠杆，导致高杠杆下止损距离过短被噪音震出
 */
export function checkStopLoss(
  currentPnlPct: number,
  peakPnlPct: number,
  leverage: number = 5,
  atrPct: number = 0.015,
  atrMult: number = 2,
): StopLossResult | null {
  const maxSl = (interceptParamsCache.get("max_stop_loss_pct") ?? 2000) / 100;
  const stopThreshold = Math.max(2, Math.min(maxSl, atrPct * 100 * atrMult * leverage));
  if (currentPnlPct <= -stopThreshold) {
    return { shouldClose: true, level: "stop_loss", description: `亏损${currentPnlPct.toFixed(1)}% 触发止损 (ATR ${(atrPct*100).toFixed(2)}% × ${atrMult} × ${leverage}x = ${stopThreshold.toFixed(1)}%)` };
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
