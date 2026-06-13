/**
 * SmartTrade - 风控模块
 * 账户级 + 持仓级 + 分批止盈
 */
import { CONFIG } from "./config";
import { type AccountInfo } from "./exchanges";
import { getTradesToday } from "./db";

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




