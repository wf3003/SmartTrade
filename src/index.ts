/**
 * SmartTrade - 入口
 * AI 驱动多交易所加密货币合约交易系统
 * 
 * 架构:
 *   [监控循环] 每 10s — 从交易所拉实盘持仓 → 止盈止损检查 → 自动执行
 *   [决策循环] 每 5min — AI 全币种分析 → 新开仓决策
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { exchangeManager } from "./exchanges";
import { generateStrategyReport } from "./strategy";
import { runStrategyEngine } from "./strategies/index";
import { getMarketReport } from "./agent";
import { checkExtremeDeviation, calcMACD, calcIndicators, convertCandles } from "./indicators";
import { checkAccountRisk, checkStopLoss, checkProfitProtect, executeStopLoss, getCurrentPrice, calcPnlPct, updatePeakEquity } from "./risk";
import { startServer, newCycle } from "./server";
import { setLatestReport, atrCache, rsiCache, indicatorCache, setCacheData, cachedPositions, applyReviewSuggestions, applySymbolAnalysis, applyBlockSignals, applyBlockSymbols, resetDynamicParams, loadFeedbackFromDb, saveFeedbackToDb, ensureHardPenalties, symbolPositionMult, applyWinRateReward, applyOptRules, getPositionRuleMultiplier, optRulesCache, loadOptRulesFromDb, interceptParamsCache, loadInterceptParamsFromDb } from "./state";
import { aiDirectionCheck, type AiCheckResult, type AiOpinion, type AiPositionSuggestion } from "./ai-check";
import { aiTradeReview, buildTradeSummary, buildSymbolStats, buildDecisionAnalysis } from "./ai-review";
import { 
  db, 
  getOpenPositions,
  getLatestOpenTrades, 
  getDecisionsToday, 
  insertDecision, 
  updateDecisionStatus,
  insertTrade, 
  insertSnapshot,
  closeTrade,
  insertPartialCloseRecord,
  getOpenPositionPeakPnlMap,
  updatePeakPnlInDb,
  getTradesHistory,
  insertAiReview,
  insertIndicatorSnapshot,
  updateSnapshotResult,
  linkSnapshotToTrade,
  seedDefaultOptRules,
  seedInterceptParams,
  saveRegimeSnapshot,
  loadRegimeSnapshot,
} from "./db";
import { runOptimizer, evaluateUnjudgedDecisions, discoverComboPatterns, detectRuleDrift, detectRegimeShift } from "./auto-optimizer";

const MONITOR_INTERVAL = 2_000;  // 每 2 秒检查持仓（模拟盘限频宽松，高频捕捉峰值）
const DECISION_INTERVAL = 5 * 60_000; // 每 5 分钟策略决策
const MINIMUM_ACCOUNT_STOP_USDT = CONFIG.accountStopLossUsdt;

// 记录每个持仓的峰值盈利（用于移动止盈）
const peakPnlMap = new Map<string, number>();
// 记录每笔开仓的 indicator_snapshot ID（平仓时更新结果）
const snapshotIdMap = new Map<string, number>();
// 记录本周期内每个持仓的已分批平仓比例（防重入）
const partialCloseMap = new Map<string, number>();
// 记录新开仓时间（防开仓瞬间止损）
const newPositionTime = new Map<string, number>();
// 同一币种+方向连败计数 + 方向阻断（key = symbol:side, 如 BCH/USDT:long）
const directionLoss = new Map<string, { count: number; blockUntil: number }>();
const DIRECTION_BLOCK_CYCLES = 12; // 连败3次后屏蔽12个决策周期（~1小时）
// 追仓频率限制（防同一币种短时间过量追仓）
const chaseWindow = new Map<string, number>(); // key=symbol:action, value=追仓次数
// 参数调整阻尼：防AI复盘反复调参
const lastParamAdjustCycle = new Map<string, number>(); // param → 上次调整的周期号
const PARAM_ADJUST_COOLDOWN_CYCLES = 6; // 同一参数至少隔6个周期才能再调
const PARAM_EMA_ALPHA = 0.35; // EMA平滑系数：新值 = 旧值×(1-α) + AI建议值×α
const PARAM_MIN_CLOSED_TRADES = 3; // 最少闭环交易数才允许调整参数

function getIntercept(name: string, fallback: number): number {
  return interceptParamsCache.get(name) ?? fallback;
}

/** aggressiveness 缩放：值越低越保守，越高越激进 */
function aggrScale(base: number, spread: number): number {
  const agg = (getIntercept("aggressiveness", 50) ?? 50) / 100; // 0-1
  return Math.round(base - (agg - 0.5) * spread);
}
/** 跟踪当前整体行情名（每次决策周期更新） */
let currentRegimeName = "unknown";
/** 从 indicatorCache 计算整体行情名称（完整7种分类） */
function getOverallRegime(): string {
  const entries = Array.from(indicatorCache.values()).filter(x => x.regime);
  if (entries.length === 0) return "unknown";
  // 按精确行情名聚合统计
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const r = e.regime;
    if (!r || r === "数据不足") continue;
    counts[r] = (counts[r] || 0) + 1;
  }
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (total === 0) return "unknown";
  // 取占比最高的行情名
  let topRegime = "unknown", topCount = 0;
  for (const [r, c] of Object.entries(counts)) {
    if (c > topCount) { topCount = c; topRegime = r; }
  }
  // 如果最高行情占比超过 50%，直接用它
  if (topCount > total * 0.5) return topRegime;
  // 否则看前两名的组合
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const r1 = sorted[0][0], r2 = sorted[1][0];
  // 如果前两名同方向（如 强趋势多+弱趋势多），合并成强方向
  if (r1.includes("趋势多") && r2.includes("趋势多")) return "强趋势多";
  if (r1.includes("趋势空") && r2.includes("趋势空")) return "强趋势空";
  if (r1.includes("偏多") && r2.includes("偏多")) return "震荡偏多";
  if (r1.includes("偏空") && r2.includes("偏空")) return "震荡偏空";
  // 多空混杂 → 用排名第一的
  return topRegime;
}
// 启动后等待 N 个周期再开新仓（让账户数据和 ATR 缓存稳定）
const STARTUP_COOLDOWN_CYCLES = 0;
// 每周期最多开 N 个新仓（按置信度排序后取头部）
const MAX_NEW_PER_CYCLE = 10;
// 本地已开仓集合（防 exchange.getPositions 延迟导致持仓上限失效）
const openedThisSession = new Set<string>();
// 超涨/超跌日志冷却（防每 2s 重复刷屏）
let _lastExtremeWarnTs: Map<string, number> | undefined;
// 监控同步防误重建：记录最近 30s 内被关掉的仓位
const _recentlyClosed = new Set<string>();
const _recentlyOpened = new Set<string>();

// ========== 统一开仓 / 关仓函数 ==========

/** 统一关仓：交易所平仓 → DB记录 → 状态清理 → 连败追踪 */
async function executeFullClose(
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
  if (pnlSource === "snap" && exitPrice > 0 && dbTrade && dbTrade.entry_price > 0) {
    const cs = symbol.includes("USDT") || symbol.includes("USD")
      ? exchangeManager.getContractSize(symbol) : 1;
    const calcPnl = side === "long"
      ? (exitPrice - dbTrade.entry_price) * qty * cs
      : (dbTrade.entry_price - exitPrice) * qty * cs;
    actualPnl = parseFloat(calcPnl.toFixed(2));
    actualPnlPct = dbTrade.margin > 0 ? (actualPnl / dbTrade.margin) * 100 : 0;
    pnlSource = "calc";
  }

  // 尝试从交易所收盘订单获取实际盈亏（生产环境 info.pnl 有值）
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
  const pnlClr = pnlSource === "exch" ? "\x1b[94m" : "\x1b[91m";
  logger.warn(`  ${pnlClr}${pnlTag}\x1b[0m ${symbol} src=${pnlSource} pnl=$${actualPnl.toFixed(2)} pct=${actualPnlPct.toFixed(2)}%`);

  if (dbTrade) {
    closeTrade(dbTrade.id, exitPrice, qty, actualPnl, actualPnlPct, closeResult.fee || 0, `${closeType}[${pnlSource}]`);
    // 级联关闭所有追仓子记录，逐条计算 pnl（防 $0 导致前端误判盈利）
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
      logger.warn(`  🧹 ${symbol} 级联关闭 ${children.length} 条追仓子记录 (含PnL计算)`);
    }
    // 更新 indicator_snapshot 结果
    const snapId = snapshotIdMap.get(symbol);
    if (snapId) {
      updateSnapshotResult(snapId, actualPnl >= 0 ? "win" : "loss", actualPnl, `${closeType}[${pnlSource}]`);
    }
    // 也更新按 trade_id 关联的 snapshot
    db.prepare("UPDATE indicator_snapshots SET result = ?, pnl = ?, close_type = ? WHERE trade_id = ? AND result = 'open'")
      .run(actualPnl >= 0 ? "win" : "loss", actualPnl, `${closeType}[${pnlSource}]`, dbTrade.id);
  }
  // 状态清理
  peakPnlMap.delete(symbol);
  partialCloseMap.delete(symbol);
  openedThisSession.delete(symbol);
  logger.info(`  📷 ${symbol} actualPnlPct=${actualPnlPct.toFixed(2)}%`);
  // 方向连败跟踪（symbol:side 粒度，如 BCH/USDT:long）
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
  // 追仓计数衰减（盈利平仓后该方向追仓计数清零）
  const chaseResetKey = `${symbol}:${side}`;
  chaseWindow.delete(chaseResetKey);
  // 标记为最近关闭，防止监控同步误重建
  _recentlyClosed.add(symbol);
  setTimeout(() => _recentlyClosed.delete(symbol), 30000);
  return { closeResult, actualPnl, actualPnlPct };
}

/** 统一部分平仓：流水账模式 — INSERT 减仓记录，不改原记录状态 */
async function executePartialClose(
  symbol: string,
  side: "long" | "short",
  qty: number,
  closePercent: number,
  dbTrade: any,
): Promise<{ closeResult: any; newPct: number; partialPnl: number }> {
  const closeResult = await exchangeManager.closePosition(symbol, side, qty);
  if (!dbTrade) {
    logger.warn(`  ⚠️ ${symbol} 部分平仓缺少DB记录，无法记录减仓`);
    return { closeResult, newPct: 0, partialPnl: 0 };
  }
  const partialPnl = closeResult.avgPrice > 0
    ? (side === "long" ? (closeResult.avgPrice - dbTrade.entry_price) : (dbTrade.entry_price - closeResult.avgPrice)) * qty
    : 0;
  // 流水账：INSERT 减仓记录，不改原记录状态（防同步逻辑误重建）
  const actualPnlPct = closeResult.avgPrice > 0 && dbTrade
    ? (side === "long" ? (closeResult.avgPrice - dbTrade.entry_price) / dbTrade.entry_price * 100 * (dbTrade.leverage || 1) : (dbTrade.entry_price - closeResult.avgPrice) / dbTrade.entry_price * 100 * (dbTrade.leverage || 1))
    : 0;
  insertPartialCloseRecord({
    parent_id: dbTrade.id as number,
    exchange: CONFIG.exchanges[0],
    symbol, side, leverage: dbTrade.leverage || 1,
    entry_price: dbTrade.entry_price,
    entry_qty: qty,
    entry_time: new Date().toISOString(),
    reason: "ai_partial_close",
    exit_price: closeResult.avgPrice || 0,
    exit_qty: qty,
    pnl: partialPnl,
    pnl_pct: actualPnlPct,
    fee: closeResult.fee || 0,
  });
  partialCloseMap.delete(symbol);
  logger.info(`  📝 流水账: ${symbol} 减仓${qty}张 PnL=$${partialPnl.toFixed(2)} (parent=${dbTrade.id})`);

  // 检查累计分批平仓量是否已达 100%，是则把原记录标记 closed
  try {
    const totalRow = db.prepare(
      "SELECT COALESCE(SUM(entry_qty), 0) as total FROM trades WHERE parent_id=? AND close_type='partial_close'"
    ).get(dbTrade.id) as any;
    const totalClosed = (totalRow?.total || 0);
    if (totalClosed >= dbTrade.entry_qty - 0.001) {
      db.prepare("UPDATE trades SET status='closed', exit_time=?, close_type='partial_close_full' WHERE id=?")
        .run(new Date().toISOString(), dbTrade.id);
      logger.warn(`  🔒 ${symbol} 分批平仓累计已达100%, 原记录#${dbTrade.id}标记为closed`);
    }
  } catch (e: any) {
    logger.error(`检查分批累计平仓量失败 ${symbol}: ${e.message}`);
  }

  return { closeResult, newPct: 50, partialPnl };
}

/** 统一开仓：先处理方向翻转（先平反向仓，再开同向），交易所开仓 → DB插入 → 状态跟踪 */
async function executeFullOpen(
  symbol: string,
  side: "long" | "short",
  qty: number,
  leverage: number,
  tickerPrice: number,
  reason: string,
  decId: number,
): Promise<{ success: boolean; fillPrice: number; error?: string }> {
  try {
    // 方向翻转处理：先平掉反方向的持仓，再开新仓
    const oppSide = side === "long" ? "short" : "long";
    const beforePositions = await exchangeManager.getPositions();
    const oppPos = beforePositions.find((p: any) => p.symbol === symbol && p.side === oppSide);
    if (oppPos && oppPos.qty > 0) {
      logger.warn(`🔄 ${symbol} 方向翻转: 先平${oppPos.qty}张${oppSide}仓`);
      try {
        await exchangeManager.closePosition(symbol, oppSide, oppPos.qty);
        // 平仓后等交易所结算
        await new Promise(r => setTimeout(r, 1000));
      } catch (e: any) {
        logger.warn(`⚠️ ${symbol} 平反向仓失败(可能已被市场平掉): ${e.message?.slice(0,60)}`);
      }
    }

    const openResult = await exchangeManager.openPosition(symbol, side, qty, leverage);
    const fillPrice = openResult.avgPrice || tickerPrice;
    _recentlyOpened.add(symbol);
    setTimeout(() => _recentlyOpened.delete(symbol), 15000);

    // 验证持仓：等1.5秒让交易所结算后确认确实有持仓
    await new Promise(r => setTimeout(r, 1500));
    const allPos = await exchangeManager.getPositions();
    const confirmed = allPos?.find((p: any) => p.symbol === symbol && p.side === side);
    if (!confirmed) {
      updateDecisionStatus(decId, "failed");
      logger.warn(`⚠️ 开仓未确认: ${symbol} ${side} ${qty}张 — 交易所无对应持仓`);
      return { success: false, fillPrice: 0, error: "交易所未确认持仓" };
    }

    updateDecisionStatus(decId, "success");

    // 检测是否已有持仓 → 追仓模式：合并到已有记录，排除 partial_open 子记录
    const existingTrade = db.prepare(
      "SELECT id, entry_qty, entry_price, leverage FROM trades WHERE symbol=? AND status='open' AND (close_type IS NULL OR close_type NOT IN ('partial_open','partial_close')) ORDER BY id DESC LIMIT 1"
    ).get(symbol) as any;

    if (existingTrade) {
      const safeLev = Math.min(leverage, existingTrade.leverage || leverage);
      const mainContractSize = exchangeManager.getContractSize(symbol);
      const mainNotional = confirmed.qty * confirmed.entryPrice * mainContractSize;
      db.prepare("UPDATE trades SET entry_qty=?, entry_price=?, leverage=?, notional=?, margin=?, side=? WHERE id=?")
        .run(confirmed.qty, confirmed.entryPrice, safeLev, mainNotional, mainNotional / safeLev, side, existingTrade.id);
      // 追仓后仓位已变，用交易所实时 PnL 重新初始化峰值
      peakPnlMap.set(symbol, confirmed?.unrealizedPnlPct || 0);
      logger.warn(`✅ 追仓: ${symbol} ${side} +${qty}张 @$${fillPrice} ${safeLev}x (交易所合并:${confirmed.qty}张 @$${confirmed.entryPrice})`);
      return { success: true, fillPrice };
    }

    // 首次开仓：正常 INSERT
    const contractSize = exchangeManager.getContractSize(symbol);
    const notional = qty * fillPrice * contractSize;
    insertTrade({
      exchange: CONFIG.exchanges[0], symbol, side,
      leverage, entry_price: fillPrice, entry_qty: qty,
      entry_time: new Date().toISOString(), reason,
      notional, margin: notional / leverage,
      entry_fee: openResult.fee || 0,
    });
    logger.warn(`✅ 开仓: ${symbol} ${side} ${qty}张 @$${fillPrice} ${leverage}x`);
    return { success: true, fillPrice };
  } catch (e: any) {
    updateDecisionStatus(decId, "failed");
    logger.error(`开仓失败 ${symbol}: ${e.message}`);
    return { success: false, fillPrice: 0, error: e.message?.slice(0, 60) };
  }
}

// 导出方向暂停状态供网页仪表盘显示

// 全局未捕获异常处理（防止决策超时等导致进程崩溃）
process.on("unhandledRejection", (reason) => {
  logger.error(`💥 未捕获的 Promise 异常: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`💥 未捕获的异常: ${err.message}`);
});

async function main() {
  // 打印版本（从 .version 文件读取）
  try {
    const fs = await import("fs");
    const ver = fs.readFileSync(".version", "utf8").trim();
    if (ver) logger.info(`⚙️ 版本: ${ver}`);
  } catch {}
  // 重启恢复复盘反馈参数（避免失忆）
  await loadFeedbackFromDb();
  // 如果是全新部署，写入默认规则
  const seeded = seedDefaultOptRules();
  if (seeded > 0) logger.info(`⚙️ 写入 ${seeded} 条默认优化规则`);
  seedInterceptParams();
  await loadOptRulesFromDb();
  await loadInterceptParamsFromDb();
  // 强制覆盖硬性惩罚（追空-8分），不受旧持久化数据影响
  ensureHardPenalties();
  // 冷却已移除：不再恢复旧冷却状态
  logger.info("=".repeat(50));
  logger.info("   SmartTrade — AI 多交易所合约交易系统");
  logger.info(`   监控: 每 ${MONITOR_INTERVAL / 1000}s | 策略决策: 每 ${DECISION_INTERVAL / 1000}s`);
  logger.info(`   账户止损: $${CONFIG.accountStopLossUsdt} | 跟踪止盈: 0.8%/0.4%→2%/0.3%`);
  logger.info("=".repeat(50));

  await exchangeManager.init();
  await startServer();

  // 从数据库恢复已存峰值 PnL（进程重启后跟踪止盈不丢失）
  const savedPeaks = getOpenPositionPeakPnlMap();
  for (const [symbol, data] of savedPeaks) {
    peakPnlMap.set(symbol, data.peakPnl);
    logger.info(`📋 恢复峰值: ${symbol} peakPnl=${data.peakPnl.toFixed(1)}%`);
  }

  // 监控循环（从交易所实时检查持仓）—— 串行防并发
  logger.info(`📡 持仓监控已启动 (每 ${MONITOR_INTERVAL / 1000}s)`);
  (async function monitorLoop() {
    while (true) {
      try { await monitorPositions(); } catch {}
      await new Promise(r => setTimeout(r, MONITOR_INTERVAL));
    }
  })();

  // AI 决策循环
  logger.info(`🤖 AI 决策循环已启动 (每 ${DECISION_INTERVAL / 1000 / 60} 分钟)`);
  await new Promise(r => setTimeout(r, 3000));  // 等交易所连接稳定
  (async function decisionLoop() {
    let nextRunAt = Date.now();
    while (true) {
      nextRunAt += DECISION_INTERVAL;
      try {
        await Promise.race([
          aiDecisionCycle(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("决策超时")), 4 * 60_000)),
        ]).catch(() => logger.warn("⏰ 决策周期超时，跳过本轮"));
      } catch {}
      const delay = Math.max(0, nextRunAt - Date.now());
      await new Promise(r => setTimeout(r, delay));
    }
  })();
}

// ========== 监控循环 ==========
async function monitorPositions() {
  try {
    // 从交易所获取实时持仓
    const positions = await exchangeManager.getPositions();
    const account = await exchangeManager.getAccount();

    // 更新账户峰值（用于回辙检查）
    updatePeakEquity(account.totalEquity);

    // 检查账户级止损（totalEquity=0 表示获取失败，跳过）
    if (account.totalEquity > 0 && account.totalEquity <= MINIMUM_ACCOUNT_STOP_USDT) {
      logger.warn(`⚠️ 账户止损触发: 权益 $${account.totalEquity.toFixed(2)} ≤ $${MINIMUM_ACCOUNT_STOP_USDT}`);
      logger.warn(`   正在平掉所有 ${positions.length} 个持仓...`);
      for (const p of positions) {
        try {
          await executeFullClose(p.symbol, p.side, p.qty, p.unrealizedPnl || 0, p.unrealizedPnlPct || 0, "account_stop");
          logger.warn(`  ✅ 已平仓: ${p.symbol}`);
        } catch (e: any) {
          logger.error(`  平仓失败 ${p.symbol}: ${e.message}`);
        }
      }
      return;
    }

    // 检查账户止盈
    if (account.totalEquity >= CONFIG.accountTakeProfitUsdt) {
      logger.warn(`🎯 账户止盈触发: 权益 $${account.totalEquity.toFixed(2)} ≥ $${CONFIG.accountTakeProfitUsdt}`);
      return;
    }

    // 去重：同一交易所+币种只保留一条（OKX 有时逐仓/全仓各返回一条）
    const seenPairs = new Set<string>();
    const uniquePositions = positions.filter(p => {
      const key = `${(p as any).exchange || "default"}|${p.symbol}`;
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });

    // 本轮已平标记（止损/止盈关闭后，sync 不重复补建）
    const closedThisCycle = new Set<string>();

    // 逐笔检查持仓状态
    for (const pos of uniquePositions) {
      // 跳过已在本轮止损或最近被关掉的持仓（防交易所结算延迟导致反复止损）
      if (closedThisCycle.has(pos.symbol)) continue;
      if (_recentlyClosed.has(pos.symbol)) continue;
      const pnlPct = pos.unrealizedPnlPct || 0;

      // 刚开仓用宽止损（30 秒内 -10%，之后恢复 -4%）
      const posAge = newPositionTime.has(pos.symbol)
        ? Date.now() - (newPositionTime.get(pos.symbol) || 0)
        : 99999;
      const isNewPosition = posAge < 30000;
      const currentPrice = pos.entryPrice > 0 
        ? pos.entryPrice * (1 + pnlPct / 100 / pos.leverage) 
        : 0;

      const dbTrade = getLatestOpenTrades().get(pos.symbol);

      // 记录峰值（首次遇到持仓时初始化，持久化到 DB）
      const key = pos.symbol;
      if (!peakPnlMap.has(key)) peakPnlMap.set(key, pnlPct);
      const prevPeak = peakPnlMap.get(key)!;
      if (pnlPct > prevPeak) {
        peakPnlMap.set(key, pnlPct);
        // 持久化到 DB，进程重启后可以恢复
        if (dbTrade?.id) updatePeakPnlInDb(dbTrade.id, pnlPct);
      }
      const peakPnl = peakPnlMap.get(key)!;

      // 超涨/超跌预警（仅日志，30s 防刷屏。平仓决策由策略引擎 2.5ATR 阈值执行）
      const extAtr = atrCache.get(pos.symbol) || 0.015;
      const extRsi = rsiCache.get(pos.symbol) || 50;
      const extDelta = pnlPct / Math.max(pos.leverage || 1, 1);
      const extreme = checkExtremeDeviation(extDelta, extAtr * 100, extRsi, pos.side, 3);
      if (extreme.hit) {
        if (!_lastExtremeWarnTs) _lastExtremeWarnTs = new Map();
        const lastTs = _lastExtremeWarnTs.get(pos.symbol) || 0;
        if (Date.now() - lastTs > 30000) {
          _lastExtremeWarnTs.set(pos.symbol, Date.now());
          logger.warn(`⚠️ ${extreme.label}预警: ${pos.symbol} ${extreme.detail}, 谨防${extreme.label === "超跌反弹" ? "反弹" : "回调"}`);
        }
      }

      // 【优化】浮盈保护：峰值>3%后回撤过半 → 平仓
      // 在跟踪止盈之前检查（避免浮盈大幅回吐）
      // 跳过最近开仓/追仓的币种（防监控和开仓抢占）
      if (_recentlyOpened.has(pos.symbol)) continue;
      if (peakPnl > 0 && pos.qty > 0) {
        const posAtr = (atrCache.get(pos.symbol) || 0.015) * 100;
        const posLev = pos.leverage || 1;
        const profitProtect = checkProfitProtect(peakPnl, pnlPct, posAtr, posLev);
        if (profitProtect?.shouldClose) {
          logger.warn(`🔒 ${profitProtect.reason} | ${pos.symbol}`);
          try {
            await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pnlPct, "profit_protect");
            closedThisCycle.add(pos.symbol);
          } catch (e: any) {
            logger.error(`浮盈保护平仓失败 ${pos.symbol}: ${e.message}`);
          }
          continue;
        }

      }

      // 跟踪止盈已由浮盈保护替代，不再需要

      // 盈利回吐全平：曾经到过高位（不含杠杆5%+），回撤到亏损，直接全平保本
      const trailLev = Math.max(pos.leverage || 1, 1);
      const peakPrice = peakPnl / trailLev;
      if (peakPrice >= 5 && pnlPct < 0 && pos.qty > 0) {
        logger.warn(`⚠️ 盈利回吐: ${pos.symbol} 峰值${peakPrice.toFixed(1)}%→当前${pnlPct.toFixed(1)}%, 全平${pos.qty}张保本`);
        try {
          await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pnlPct, "profit_revert");
          closedThisCycle.add(pos.symbol);
        } catch (e: any) {
          logger.error(`盈利回吐全平失败 ${pos.symbol}: ${e.message}`);
        }
        continue;
      }

      // 时间止损：持仓 > 4 小时且从未盈利且当前亏损 ≥ -2% → 平仓释放保证金
      const posAgeHours = newPositionTime.has(pos.symbol)
        ? (Date.now() - (newPositionTime.get(pos.symbol) || 0)) / 3600000
        : 0;
      if (posAgeHours > 4 && pnlPct <= -2 && peakPnl <= 0) {
        logger.warn(`⏰ 时间止损: ${pos.symbol} 持仓${posAgeHours.toFixed(1)}h从未盈利, 亏损${pnlPct.toFixed(1)}%, 平仓释放保证金`);
        try {
          await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, "time_stop");
          logger.warn(`  ✅ 时间止损平仓成功: ${pos.symbol} ${pos.qty}张`);
          closedThisCycle.add(pos.symbol);
        } catch (e: any) {
          logger.error(`时间止损平仓失败 ${pos.symbol}: ${e.message}`);
        }
        continue;
      }

      // 【优化】120分钟从未盈利且浮亏 → 平仓释放
      const posAgeMin = newPositionTime.has(pos.symbol)
        ? (Date.now() - (newPositionTime.get(pos.symbol) || 0)) / 60000
        : 0;
      if (posAgeMin > 120 && pnlPct < 0 && peakPnl < 0.5 && pos.qty > 0) {
        logger.warn(`⏰ 无盈利平仓: ${pos.symbol} ${posAgeMin.toFixed(0)}分从未过半盈, 平仓`);
        try {
          await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, "no_profit_stop");
          closedThisCycle.add(pos.symbol);
        } catch (e: any) {
          logger.error(`无盈利平仓失败 ${pos.symbol}: ${e.message}`);
        }
        continue;
      }

      // 止损检查：趋势中 4× ATR（容忍正常回调），震荡中 2× ATR
      const atrVal = atrCache.get(pos.symbol) || 0.015;
      const isTrend = currentRegimeName.includes("趋势") || currentRegimeName === "unknown";
      const atrMult = isTrend ? 4 : 2;
      const stopLossCheck = isNewPosition
        ? (pnlPct <= -15 ? { shouldClose: true, level: "stop_loss", description: `新仓亏损${pnlPct.toFixed(1)}% 触发宽止损` } : null)
        : checkStopLoss(pnlPct, peakPnl, pos.leverage || 5, atrVal, atrMult);
      if (stopLossCheck?.shouldClose) {
        logger.warn(`🛑 ${stopLossCheck.description} | ${pos.symbol}`);
        try {
          await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, stopLossCheck.level);
          logger.warn(`  ✅ 止损平仓成功: ${pos.symbol} ${pos.qty}张`);
          closedThisCycle.add(pos.symbol);
        } catch (e: any) {
          logger.error(`止损平仓失败 ${pos.symbol}: ${e.message}`);
        }
      }
    }

    // 双向同步
    const liveSymbols = new Set(positions.map(p => p.symbol));
    const dbOpen = (db.prepare(
      `SELECT * FROM trades WHERE status='open' AND (close_type IS NULL OR close_type = '')
       AND entry_time < datetime('now', '-5 seconds')`
    ) as any).all() as any[];
    // A. 交易所有但 DB 没有 → 补建记录（清库后恢复）
    for (const pos of uniquePositions) {
      if (closedThisCycle.has(pos.symbol)) continue; // 本轮已止损/止盈平仓，不补建
      if (_recentlyClosed.has(pos.symbol)) continue; // 最近被AI/策略关掉，等待交易所结算
      if (_recentlyOpened.has(pos.symbol)) continue; // 最近开仓未入库，等待DB写入
      if (!dbOpen.find((t: any) => t.symbol === pos.symbol)) {
        const existing = (db.prepare("SELECT id FROM trades WHERE symbol=? AND status='open' AND (close_type IS NULL OR close_type NOT IN ('partial_open','partial_close')) ORDER BY id DESC LIMIT 1").get(pos.symbol) as any);
        if (!existing) {
          insertTrade({
            exchange: CONFIG.exchanges[0], symbol: pos.symbol, side: pos.side,
            leverage: pos.leverage, entry_price: pos.entryPrice, entry_qty: pos.qty,
            entry_time: new Date().toISOString(), reason: "sync_rebuild",
            notional: pos.margin * pos.leverage, margin: pos.margin,
          });
          logger.warn(`🔧 同步: ${pos.symbol} 交易所已有但DB无记录，已补建`);
        }
      }
    }
    // B. DB 有但交易所已无 → 关闭
    for (const t of dbOpen) {
      if (!liveSymbols.has(t.symbol)) {
        closeTrade(t.id, 0, t.entry_qty, 0, 0, 0, "sync_closed");
        // 级联关闭追仓子记录
        db.prepare("UPDATE trades SET status='closed', close_type='sync_closed' WHERE parent_id=? AND status='open' AND close_type='partial_open'").run(t.id);
        logger.warn(`🔧 同步: ${t.symbol} 交易所已无，关闭DB记录`);
      }
    }
    // C. 主记录的 qty/price 与交易所同步（追仓后修复主记录滞后）
    for (const pos of uniquePositions) {
      const dbTrade = getLatestOpenTrades().get(pos.symbol);
      if (dbTrade && (Math.abs(dbTrade.entry_qty - pos.qty) > 0.01 || Math.abs(dbTrade.entry_price - pos.entryPrice) > 0.001)) {
        const cs = exchangeManager.getContractSize(pos.symbol);
        const nu = pos.qty * pos.entryPrice * cs;
        db.prepare("UPDATE trades SET entry_qty=?, entry_price=?, notional=?, margin=? WHERE id=?")
          .run(pos.qty, pos.entryPrice, nu, nu / (dbTrade.leverage || 1), dbTrade.id);
        logger.info(`🔧 同步: ${pos.symbol} qty ${dbTrade.entry_qty}→${pos.qty} price ${dbTrade.entry_price?.toFixed(4)}→${pos.entryPrice?.toFixed(4)} notional→${nu.toFixed(0)}`);
      }
    }

    // 账户快照（每 60 秒只存一次，减少写库频率）
    const now = Date.now();
    if (!lastSnapshotTime || now - lastSnapshotTime > 10000) {
      insertSnapshot({
        time: new Date().toISOString(),
        total_equity: account.totalEquity,
        unrealized_pnl: account.unrealizedPnl,
        realized_pnl_day: 0,
        margin_used: account.marginUsed,
        open_positions: positions.length,
      });
      // 缓存最新账户+持仓供 status 接口使用（防交易所限频）
      setCacheData(account, positions);
      lastSnapshotTime = now;
    }
  } catch (e: any) {
    logger.error(`监控异常: ${e.message}`);
  }
}

let lastSnapshotTime = 0;

// ========== AI 决策循环 ==========
let aiCycleNumber = 0;
async function aiDecisionCycle() {
  aiCycleNumber++;
  try {
    // 1. 市场数据
    const tickers = await exchangeManager.getTickers(CONFIG.symbols);
    if (tickers.size === 0) { logger.warn("无市场数据"); return; }
    logger.info(`===== AI 决策周期 #${aiCycleNumber} =====`);


    // 2. 持仓 & 账户
    const positions = await exchangeManager.getPositions();
    const account = await exchangeManager.getAccount();
    const openTrades = getOpenPositions() as any[];

    // 3. 账户风控
    const risk = checkAccountRisk(account, positions.length);
    if (risk.accountStop) {
      logger.warn(`⚠️ 账户风控: ${risk.reason}，不开新仓`);
    }

    // 4. AI 全币种报告
    const recentDecs = getDecisionsToday();
    
    // 获取多时间框架数据
    const ohlcvData = new Map<string, Record<string, any[]>>();
    for (const sym of CONFIG.symbols) { // 全币种取K线 (ccxt enableRateLimit 自动控速)
      try {
        const tfData = await exchangeManager.getMultiTimeframeData(sym);
        if (Object.keys(tfData).length > 0) ohlcvData.set(sym, tfData);
      } catch {}
    }
    logger.info(`📡 K线:${ohlcvData.size}/${CONFIG.symbols.length}币种 行情:${tickers.size}/${CONFIG.symbols.length}币种`);
    
    // === 策略引擎: 三个独立策略分析 ===
    const strategyReport = runStrategyEngine(tickers, ohlcvData, positions, account);
    logger.info(`📡 策略引擎: ${strategyReport.analyses.length}币种 | ${strategyReport.summary}`);
    // 策略引擎已填充 indicatorCache，更新当前行情名
    currentRegimeName = getOverallRegime();
    logger.info(`📊 当前行情: ${currentRegimeName}`);
    
    // === AI 投资委员会主席: 综合决策 ===
    const aiReport = await getMarketReport(strategyReport, positions, account, recentDecs, openTrades);
    if (!aiReport) { logger.warn("AI主席未返回决策"); return; }
    
    const report = aiReport as any;
    // 注入 aiReview 供前端展示
    {
      const aiReviewArr: any[] = [];
      for (const t of aiReport.newTrades) {
        aiReviewArr.push({
          symbol: t.symbol,
          score: Math.round((t.confidence || 0.5) * 100),
          reason: t.reason || "",
        });
      }
      (report as any).aiReview = aiReviewArr;
    }
    setLatestReport(report);
    newCycle();
    
    // AI close 完全移除：不开不关，AI只开新仓

    // 6. 开新仓
    const execLog: string[] = [];

    // 启动保护：前 N 个周期不开新仓，让数据稳定
    if (aiCycleNumber <= STARTUP_COOLDOWN_CYCLES) {
      logger.info(`⏸️ 启动保护: 第${aiCycleNumber}周期不开新仓 (需等待${STARTUP_COOLDOWN_CYCLES}个周期)`);
      execLog.push("启动保护中，跳过开仓");
    }

    if (aiCycleNumber <= STARTUP_COOLDOWN_CYCLES) {
      // 跳过开仓，但持仓指令照常执行
      let openedThisCycle = MAX_NEW_PER_CYCLE; // 直接跳过
      if (!(report as any).tradeResults) (report as any).tradeResults = [];
      for (const trade of report.newTrades) {
        (report as any).tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "启动保护中" });
      }
    } else if (report.newTrades && report.newTrades.length > 0) {
      const actionable = report.newTrades
        .filter((t: any) => t.action !== "hold")
        .sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0));
      if (actionable.length === 0) {
        logger.info(`📋 本轮决策无开仓 (${report.newTrades.length}条均为hold)`);
        execLog.push("AI 全部观望，无开仓");
      } else if (risk.accountStop || !risk.allowOpen) {
        const reason = risk.reason || "未知原因";
        logger.warn(`⚠️ 风控阻止开仓: ${reason}`);
        execLog.push(`风控阻止: ${reason}`);
        // 记录被风控跳过的新开仓尝试
        for (const trade of report.newTrades) {
          const skipId = insertDecision({
            time: new Date().toISOString(), ai_model: CONFIG.ai.model,
            signal: trade.action, symbol: trade.symbol, action: trade.action,
            leverage: trade.leverage, amount: trade.amountPercent,
            reason: `风控阻止: ${reason}`,
            confidence: trade.confidence,
            raw_response: JSON.stringify(trade),
          });
          updateDecisionStatus(skipId, "skipped");
        }
      } else {
      const existingSymbols = new Set([
        ...positions.map(p => p.symbol),
        ...openedThisSession,
      ]);
      let openedThisCycle = 0;
      const tradeResults: any[] = (report as any).tradeResults = [];
      for (const trade of report.newTrades) {
        if (openedThisCycle >= MAX_NEW_PER_CYCLE) { tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "每周期开仓已达上限" }); logger.info(`每周期最多开${MAX_NEW_PER_CYCLE}仓，已达上限`); break; }
        // 方向由AI决定，strategy仅给出参考方向
        // 已有持仓 → 追仓模式，由 executeFullOpen 合并处理，不再跳过
        // 方向阻断：同一币种+方向连败3次后自动屏蔽N周期
        const dirKey = `${trade.symbol}:${trade.action === 'buy' ? 'long' : 'short'}`;
        const dirInfo = directionLoss.get(dirKey);
        if (dirInfo && dirInfo.blockUntil > aiCycleNumber) {
          const remain = dirInfo.blockUntil - aiCycleNumber;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `方向阻断(${dirKey})剩余${remain}周期` });
          logger.info(`🚫 ${dirKey} 方向阻断中，剩余${remain}周期 (连败${dirInfo.count}次)`);
          continue;
        }
        if (existingSymbols.size >= CONFIG.maxPositions && !existingSymbols.has(trade.symbol)) { tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "持仓数已达上限" }); logger.info(`持仓数已达上限 ${CONFIG.maxPositions}`); break; }
        // 追仓频率限制：同一币种在6个周期内最多追仓3次
        const chaseKey = `${trade.symbol}:${trade.action}`;
        if (existingSymbols.has(trade.symbol) && (chaseWindow.get(chaseKey) || 0) >= 3) {
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "追仓3次已达上限" });
          logger.info(`⏸️ ${chaseKey} 追仓已达3次上限，跳过`);
          continue;
        }
        if (existingSymbols.has(trade.symbol)) {
          chaseWindow.set(chaseKey, (chaseWindow.get(chaseKey) || 0) + 1);
        }


        // [层叠日志] 每个信号记录所有过滤节点的通过状态
        const cascade: string[] = [];
        const ck = (node: string, pass: boolean) => cascade.push(`${node}:${pass ? "✅" : "❌"}`);

        // AI主席置信度过滤：<0.3跳过，0.3-0.5轻仓，0.5-0.7半仓
        const aiScore = Math.round((trade.confidence || 0.5) * 100);
        if (!CONFIG.bypassQualityFilters && (trade.confidence < 0.3 || aiScore < 30)) {
          const aiRsn = trade.reason || "置信度不足";
          const msg = `⏭️ ${trade.symbol} AI置信度${aiScore}<30，跳过 (${aiRsn})`;
          tradeResults.push({ symbol: trade.symbol, status: "ai_rejected", reason: `AI置信度${aiScore}: ${aiRsn}` });
          logger.info(msg);
          execLog.push(msg);
          continue;
        }
        if (aiScore < 50) {
          trade.amountPercent = Math.round(trade.amountPercent / 4);
          logger.info(`   ${trade.symbol} AI置信度${aiScore}，仓位降至1/4=${trade.amountPercent}%`);
        } else if (aiScore < 70) {
          trade.amountPercent = Math.round(trade.amountPercent / 2);
          logger.info(`   ${trade.symbol} AI置信度${aiScore}，仓位减半至${trade.amountPercent}%`);
        }

        // 行情质量：从策略引擎获取
        const sa = strategyReport.analyses.find(a => a.symbol === trade.symbol);
        const ticker = tickers.get(trade.symbol);

        // ===== 硬性信号过滤：AI复盘反复验证的亏损规律，代码级阻断 =====

        // ② AI评分<阈值直接跳
        const aiScoreMin = aggrScale(getIntercept("ai_score_min", 45), 20);
        ck(`AI(${aiScore})`, aiScore >= aiScoreMin);
        if (!CONFIG.bypassQualityFilters && aiScore < aiScoreMin) {
          const msg = `⏭️ ${trade.symbol} AI评分${aiScore}<${aiScoreMin}，质量不足跳过`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `AI评分不足` });
          logger.info(msg + ` | cascade: ${cascade.join(" ")}`); execLog.push(msg);
          try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: msg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
          continue;
        }
        const mq = sa?.sentiment?.marketQuality ?? 50;
        const mqMin = aggrScale(getIntercept("market_quality_min", 20), 10);
        ck(`MQ(${mq})`, mq >= mqMin);
        if (!CONFIG.bypassQualityFilters && mq < mqMin) {
          const msg = `⏭️ ${trade.symbol} 行情质量${mq}<${mqMin}，跳过`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `行情质量低(${mq})` });
          logger.info(msg + ` | cascade: ${cascade.join(" ")}`);
          execLog.push(msg);
          try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: msg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate, mq }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
          continue;
        } else if (mq < 40) {
          const mqLoMult = (interceptParamsCache.get("pos_mq_mult_low") ?? 40) / 100;
          trade.amountPercent = Math.round(trade.amountPercent * mqLoMult);
          trade.leverage = Math.max(2, trade.leverage - 2);
          logger.info(`   ${trade.symbol} 行情质量${mq}，仓位乘数${mqLoMult}×至${trade.amountPercent}%，杠杆降至${trade.leverage}x`);
        } else if (mq < 70) {
          const mqMdMult = (interceptParamsCache.get("pos_mq_mult_med") ?? 60) / 100;
          trade.amountPercent = Math.round(trade.amountPercent * mqMdMult);
          logger.info(`   ${trade.symbol} 行情质量${mq}，仓位乘数${mqMdMult}×至${trade.amountPercent}%`);
        }

        // 入场质量硬阻断：方向对应的评分<35不开仓（原<20，收紧以过滤RSI超卖/B追空）
        // AI评分≥70的高信心信号放宽EQ门槛至25，防止BB下轨在强趋势中误拦优质空单
        if (sa?.entryQuality) {
          const entryScore = trade.action === "buy"
            ? sa.entryQuality.longEntryScore
            : sa.entryQuality.shortEntryScore;
          const eqMin = aggrScale(getIntercept("entry_quality_min", 35), 15);
          const eqThreshold = aiScore >= 70 ? Math.min(eqMin, 25) : Math.min(eqMin, 35);
          ck(`EQ(${trade.action})`, entryScore >= eqThreshold);
          if (!CONFIG.bypassQualityFilters && entryScore < eqThreshold) {
            const msg = `⏭️ ${trade.symbol} 入场质量${entryScore}<${eqThreshold}，${trade.action === "buy" ? "做多" : "做空"}时机差，跳过`;
            tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `入场质量低(${entryScore})` });
            logger.info(msg + ` | cascade: ${cascade.join(" ")}`);
            execLog.push(msg);
            try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: msg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate, entryScore }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
            continue;
          } else if (entryScore < eqThreshold + 20) {
            trade.amountPercent = Math.round(trade.amountPercent * 0.5);
            logger.info(`   ${trade.symbol} 入场质量${entryScore}<${eqThreshold+20}，仓位减半至${trade.amountPercent}%`);
          } else if (!CONFIG.bypassQualityFilters && sa.entryQuality.suggestion === "unfavorable") {
            const msg = `⏭️ ${trade.symbol} 入场质量评级 unfavorable，当前周期不开新仓`;
            tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "入场质量unfavorable" });
            logger.info(msg);
            execLog.push(msg);
            try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: msg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
            continue;
          }
        }

        // 5. 基于历史胜率的仓位乘数：高胜率币种自动放大仓位
        const posMult = symbolPositionMult.get(trade.symbol) ?? 1.0;
        if (posMult !== 1.0) {
          const origPct = trade.amountPercent;
          trade.amountPercent = Math.min(CONFIG.basePositionPct * 2, Math.round(trade.amountPercent * posMult));
          logger.info(`   ${trade.symbol} 胜率仓位乘数x${posMult.toFixed(1)}: ${origPct}%→${trade.amountPercent}%`);
        }

        // 5.5 总仓位保证金上限：所有持仓总 margin 不超过总资金上限
        const existingTotalMargin = positions
          .reduce((sum: number, p: any) => sum + (p.margin || 0), 0);
        const equity = account.totalEquity || 1;
        const newMarginForTotal = Number(account.availableBalance) * trade.amountPercent / 100;
        const totalExposure = (existingTotalMargin / equity) * 100;
        const newTotalExposure = (newMarginForTotal / equity) * 100;
        const maxTotalMargin = getIntercept("max_total_margin_pct", CONFIG.maxTotalMarginPct);
        if (totalExposure + newTotalExposure > maxTotalMargin) {
          const totalMsg = `总仓位保证金已达${totalExposure.toFixed(1)}%，新仓${newTotalExposure.toFixed(1)}%>${maxTotalMargin}%上限`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: totalMsg });
          logger.info(`⏸️ ${trade.symbol} ${totalMsg}，跳过`);
          try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: totalMsg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
          continue;
        }

        // 5.6 单币种保证金上限：防止单一币种过度集中（如BNB占满全仓）
        const existingSymbolMargin = positions
          .filter((p: any) => p.symbol === trade.symbol)
          .reduce((sum: number, p: any) => sum + (p.margin || 0), 0);
        const symbolExposure = (existingSymbolMargin / equity) * 100;
        const newSymbolExposure = (newMarginForTotal / equity) * 100;
        const maxSymbolMargin = getIntercept("max_symbol_margin_pct", CONFIG.maxSymbolMarginPct);
        if (symbolExposure + newSymbolExposure > maxSymbolMargin) {
          const symbolMsg = `${trade.symbol} 单币种保证金已达${symbolExposure.toFixed(1)}%，新仓${newSymbolExposure.toFixed(1)}%>${maxSymbolMargin}%上限`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: symbolMsg });
          logger.info(`⏸️ ${symbolMsg}，跳过`);
          try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: symbolMsg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
          continue;
        }

        // 6. 同方向保证金硬上限：用过滤后的最终仓位检查，防市场反弹多仓同时亏损
        const tradeSide = trade.action === "buy" ? "long" : "short";
        const existingSideMargin = positions
          .filter((p: any) => p.side === tradeSide)
          .reduce((sum: number, p: any) => sum + (p.margin || 0), 0);
        const newMargin = Number(account.availableBalance) * trade.amountPercent / 100;
        const sideExposure = (existingSideMargin / equity) * 100;
        const newExposure = (newMargin / equity) * 100;
        const maxSideMargin = getIntercept("max_side_margin_pct", 50);
        if (sideExposure + newExposure > maxSideMargin) {
          const msg = `同方向保证金已达${sideExposure.toFixed(1)}%，新仓${newExposure.toFixed(1)}%>${maxSideMargin}%上限`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: msg });
          logger.info(`⏸️ ${trade.symbol} ${msg}，跳过`);
          try { insertDecision({ time: new Date().toISOString(), signal: trade.action, symbol: trade.symbol, action: trade.action, leverage: trade.leverage, amount: trade.amountPercent, reason: msg, confidence: trade.confidence, raw_response: JSON.stringify({ price: ticker?.price, rsi: rsiCache.get(trade.symbol), atrPct: atrCache.get(trade.symbol), fundingRate: ticker?.fundingRate }) }); db.prepare("UPDATE decisions SET status='skipped' WHERE id=last_insert_rowid()").run(); } catch {}
          continue;
        }

        // [CASCADE] 每信号输出完整过滤路径
        logger.info(`  [CASCADE] ${trade.symbol} ${trade.action}: ${cascade.join(" ")}`);

        const aiRsn = trade.reason || "无AI分析";
        const aiSc = aiScore;
        const side = trade.action === "buy" ? "long" : "short";
        const margin = Number(account.availableBalance) * trade.amountPercent / 100;

        const snap = {
          rsi: Math.round(rsiCache.get(trade.symbol) || 50),
          atrPct: ((atrCache.get(trade.symbol) || 0.015) * 100).toFixed(2),
          fundingRatePct: ((ticker?.fundingRate || 0) * 100).toFixed(4),
          vol24hM: ticker?.volume24h ? (ticker.volume24h / 1e6).toFixed(1) : '?',
          price: ticker?.price,
        };
        // 应用 opt_rules：统计规则 + 复盘惩罚共同调整评分
        const ind = indicatorCache.get(trade.symbol);
        const indRsi1h = ind?.rsi_1h ?? rsiCache.get(trade.symbol) ?? 50;
        const indAdx1h = ind?.adx_1h ?? 30;
        const indRsi1d = ind?.rsi_1d ?? 50;
        const indAdx1d = ind?.adx_1d ?? 30;
        const indAtrPct = ind?.atr_pct ?? (atrCache.get(trade.symbol) ?? 0.015) * 100;
        const indEmaDist = ind?.ema_dist_pct ?? 0;
        const mqVal = sa?.sentiment?.marketQuality ?? 50;
        const entryQVal = sa?.entryQuality
          ? (trade.action === "buy" ? sa.entryQuality.longEntryScore : sa.entryQuality.shortEntryScore)
          : 50;
        const currentRegime = ind?.regime ?? "unknown";
        const optResult = applyOptRules(
          trade.symbol, side, aiSc,
          indRsi1h, indAdx1h, indRsi1d, indAdx1d,
          indAtrPct, indEmaDist, ticker?.fundingRate ?? 0,
          ticker?.volume24h ?? 0, mqVal, entryQVal,
          currentRegime
        );
        if (optResult.score !== aiSc) {
          logger.info(`   opt_rules 调整评分: ${aiSc}→${optResult.score} (${optResult.logs.join(", ")})`);
        }
        // opt_rules 中的仓位规则
        const optPosMult = getPositionRuleMultiplier(
          trade.symbol, side,
          indRsi1h, indAdx1h, indRsi1d, indAdx1d,
          indAtrPct, indEmaDist, ticker?.fundingRate ?? 0,
          ticker?.volume24h ?? 0, mqVal, entryQVal,
          currentRegime
        );
        if (optPosMult !== 1.0) {
          const origPct = trade.amountPercent;
          trade.amountPercent = Math.min(CONFIG.basePositionPct * 2, Math.round(trade.amountPercent * optPosMult));
          logger.info(`   opt_rules 仓位乘数x${optPosMult.toFixed(2)}: ${origPct}%→${trade.amountPercent}%`);
        }

        // 仓位最小值保护：不管削减多少层，不低于 base/4
        const minPct = Math.max(1, Math.round(CONFIG.basePositionPct / 4));
        if (trade.amountPercent < minPct) {
          const origPct = trade.amountPercent;
          trade.amountPercent = minPct;
          logger.info(`   仓位触及最小值保护: ${origPct}%→${minPct}%`);
        }

        logger.warn(`🤖 AI 开仓: ${trade.action} ${trade.symbol} | ${trade.leverage}x | ${trade.amountPercent}%`);
        logger.info(`   AI评分:${optResult.score} ${aiRsn}`);
        logger.info(`   快照 RSI:${snap.rsi} ATR:${snap.atrPct}% 费率:${snap.fundingRatePct}% 量:${snap.vol24hM}M`);

        // 保存 indicator_snapshot（开仓前记录所有指标值）
        const signalType = trade.reason?.includes("追空") ? "chase_short"
          : trade.reason?.includes("追多") || trade.reason?.includes("追涨") ? "chase_long"
          : trade.reason?.includes("反转") ? "reversal" : "continuation";
        const snapId = insertIndicatorSnapshot({
          decision_id: null, trade_id: null, time: new Date().toISOString(),
          symbol: trade.symbol, side, regime: currentRegime,
          rsi_1h: indRsi1h, rsi_1d: indRsi1d,
          adx_1h: indAdx1h, adx_1d: indAdx1d,
          atr_pct: indAtrPct, ema_dist_pct: indEmaDist,
          funding_rate: ticker?.fundingRate ?? null,
          volume_24h: ticker?.volume24h ?? null,
          market_quality: mqVal, entry_quality: entryQVal,
          leverage: trade.leverage, position_pct: trade.amountPercent,
          ai_confidence: trade.confidence, ai_score: optResult.score,
          signal_type: signalType,
        });
        snapshotIdMap.set(trade.symbol, Number(snapId));

        const decId = insertDecision({
          time: new Date().toISOString(), ai_model: CONFIG.ai.model,
          signal: trade.action, symbol: trade.symbol, action: trade.action,
          leverage: trade.leverage, amount: trade.amountPercent,
          reason: `AI:${aiSc}分 ${aiRsn}`, confidence: trade.confidence,
          raw_response: JSON.stringify({ trade, aiScore: aiSc, aiReason: aiRsn, indicatorsSnapshot: snap }),
        });
        if (!ticker || Number(ticker.price) <= 0) { updateDecisionStatus(decId, "failed"); continue; }

        const contractSize = exchangeManager.getContractSize(trade.symbol);
        let qty = Math.max(1, Math.floor(margin * Number(trade.leverage) / (Number(ticker.price) * Number(contractSize))));
        if (margin <= 0 || qty <= 0) {
          logger.warn(`⚠️ 保证金不足: 可用$${Number(account.availableBalance).toFixed(2)}`);
          updateDecisionStatus(decId, "failed");
          continue;
        }

        const { success, fillPrice, error } = await executeFullOpen(trade.symbol, side, qty, Number(trade.leverage), Number(ticker.price), trade.reason, Number(decId));
        if (success) {
          tradeResults.push({ symbol: trade.symbol, status: "opened", side, qty, price: fillPrice, leverage: trade.leverage });
          existingSymbols.add(trade.symbol);
          openedThisSession.add(trade.symbol);
          openedThisCycle++;
          newPositionTime.set(trade.symbol, Date.now());
          // 回写 snapshot 的 trade_id
          const dbTradeRow = db.prepare("SELECT id FROM trades WHERE symbol = ? AND status = 'open' AND (close_type IS NULL OR close_type NOT IN ('partial_open','partial_close')) ORDER BY id DESC LIMIT 1").get(trade.symbol) as any;
          if (dbTradeRow) {
            const snapId2 = snapshotIdMap.get(trade.symbol);
            if (snapId2) linkSnapshotToTrade(snapId2, dbTradeRow.id);
          }
          // 逐笔延迟，避免 demo 环境瞬时并发触发限频
          await new Promise(r => setTimeout(r, 1500));
        } else {
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `开仓失败: ${error || "未知"}` });
        }
      }
      }
    }
    if (execLog.length > 0 && report.execution) report.execution.log = execLog;

    // 策略评分已移除，分析日志改为展示AI方向复核摘要

    // 6. AI 交易复盘（每 6 周期≈30 分钟一次，独立定时器，不阻塞决策循环）
    scheduleReview(aiCycleNumber, tickers);
  } catch (e: any) {
    logger.error(`AI 决策异常: ${e.message}`);
  }
}

/** 独立复盘定时器：每 6 周期≈30分钟触发一次，不阻塞决策主流程 */
let lastReviewCycle = 0;
async function scheduleReview(currentCycle: number, tickers: Map<string, any>) {
  if (currentCycle % 6 !== 0 || currentCycle === lastReviewCycle) return;
  try {
    const allTrades = getTradesHistory(7) as any[];
    const tradeSummary = buildTradeSummary(allTrades);
    const symbolStats = buildSymbolStats(allTrades);
    // 当前持仓实时盈亏摘要
    const posLines = cachedPositions.length > 0
      ? cachedPositions.map((p: any) => {
          const peak = peakPnlMap.get(p.symbol) ?? 0;
          const atr = (atrCache.get(p.symbol) || 0.015) * 100;
          return `${p.symbol} ${p.side} | PnL:${(p.unrealizedPnlPct||0).toFixed(1)}% 峰值:${peak.toFixed(1)}% 杠杆:${p.leverage}x ATR:${atr.toFixed(1)}%`;
        }).join("\n")
      : "无持仓";
    const openSummary = `当前${cachedPositions.length}个持仓:\n${posLines}`;
    const configStr = `杠杆:${CONFIG.defaultLeverage}x 止损:2-8%(ATR×2) 浮盈保护:阶梯回撤 | 当前行情:${currentRegimeName}`;
    logger.info(`📊 AI 复盘(周期#${currentCycle})开始调用...`);
    const btLogs = db.prepare("SELECT symbol, optimal_strategy, confidence, best_tf FROM backtest_logs WHERE time > datetime('now', '-1 hour') ORDER BY id DESC LIMIT 50").all() as any[];
    const btSummary = btLogs.length > 0 ? btLogs.map((l: any) => `${l.symbol}: ${l.optimal_strategy}(cf${l.confidence}% ${l.best_tf})`).join("\n") : "";
    // 获取近期AI决策历史（含AI评分和理由）
    const recentDecisions = (db.prepare("SELECT symbol, action, reason, status, raw_response FROM decisions WHERE raw_response IS NOT NULL AND raw_response != '' AND time > datetime('now', '-2 hours') ORDER BY id DESC LIMIT 10").all() as any[]) as any[];
    const decAnalysis = buildDecisionAnalysis(recentDecisions);
    // 回望评估被拦截信号：决策时价格 vs 当前价格 → 如果开了仓现在盈亏多少
    const skippedDecisions = db.prepare(
      "SELECT symbol, action, reason, status, raw_response FROM decisions WHERE status='skipped' AND raw_response IS NOT NULL AND raw_response != '' AND time > datetime('now', '-2 hours') ORDER BY id DESC LIMIT 30"
    ).all() as any[];
    let skippedAnalysis = "";
    // 按拦截参数聚合（用于 adjustIntercepts 的虚拟成交计数 + 精准调参）
    interface SkippedParamProfile {
      blocked: number; wouldWin: number; wouldLose: number; neutral: number;
      winRsis: number[]; winFrs: number[]; winPcts: number[];
      lossRsis: number[]; lossFrs: number[]; lossPcts: number[];
      winScores: number[]; lossScores: number[];
    }
    const skippedParamProfiles: Record<string, SkippedParamProfile> = {};
    function classifySkippedReason(reason: string): string {
      if (reason.includes("AI评分")) return "ai_score_min";
      if (reason.includes("行情质量")) return "market_quality_min";
      if (reason.includes("入场质量")) return "entry_quality_min";
      if (reason.includes("回测") || reason.includes("延续率") || reason.includes("反转率")) return "backtest_filter";
      return "other";
    }
    function newParamProfile(): SkippedParamProfile {
      return { blocked: 0, wouldWin: 0, wouldLose: 0, neutral: 0,
        winRsis: [], winFrs: [], winPcts: [],
        lossRsis: [], lossFrs: [], lossPcts: [],
        winScores: [], lossScores: [] };
    }
    if (skippedDecisions.length > 0) {
      const bySymbol: Record<string, { skipped: number; wouldWin: number; wouldLose: number }> = {};
      for (const d of skippedDecisions) {
        try {
          const raw = JSON.parse(d.raw_response);
          const priceAt = raw.price;
          if (!priceAt || priceAt <= 0) continue;
          const ticker = tickers.get(d.symbol);
          if (!ticker?.price || ticker.price <= 0) continue;
          const changePct = (ticker.price - priceAt) / priceAt * 100;
          const wouldProfit = d.action === "sell" ? changePct < -0.5 : changePct > 0.5;
          const wouldLoss = d.action === "sell" ? changePct > 0.5 : changePct < -0.5;
          if (!bySymbol[d.symbol]) bySymbol[d.symbol] = { skipped: 0, wouldWin: 0, wouldLose: 0 };
          bySymbol[d.symbol].skipped++;
          if (wouldProfit) bySymbol[d.symbol].wouldWin++;
          if (wouldLoss) bySymbol[d.symbol].wouldLose++;
          // 按拦截参数聚合（含特征画像）
          const param = classifySkippedReason(d.reason);
          if (!skippedParamProfiles[param]) skippedParamProfiles[param] = newParamProfile();
          const pf = skippedParamProfiles[param];
          pf.blocked++;
          const relevantScore = (raw as any).mq ?? (raw as any).entryScore ?? (raw.rsi != null ? Math.round(Number(raw.rsi)) : 0);
          if (wouldProfit) {
            pf.wouldWin++;
            if (raw.rsi != null) pf.winRsis.push(Number(raw.rsi));
            if (raw.fundingRate != null) pf.winFrs.push(Number(raw.fundingRate));
            pf.winPcts.push(changePct);
            pf.winScores.push(relevantScore);
          } else if (wouldLoss) {
            pf.wouldLose++;
            if (raw.rsi != null) pf.lossRsis.push(Number(raw.rsi));
            if (raw.fundingRate != null) pf.lossFrs.push(Number(raw.fundingRate));
            pf.lossPcts.push(changePct);
            pf.lossScores.push(relevantScore);
          } else {
            pf.neutral++;
          }
        } catch {}
      }
      const symLines = Object.entries(bySymbol).map(([sym, s]) =>
        `  ${sym}: 被拦${s.skipped}次 | 若开仓→盈利${s.wouldWin}/亏损${s.wouldLose}/中性${s.skipped-s.wouldWin-s.wouldLose}`
      );
      // 按参数特征画像，含 WHY 分析
      function fmtRange(vals: number[], pct: boolean): string {
        if (vals.length === 0) return "无数据";
        const sorted = [...vals].sort((a, b) => a - b);
        const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
        const lo = sorted[0], hi = sorted[sorted.length - 1];
        const sf = pct ? 2 : 1;
        return `${lo.toFixed(sf)}~${hi.toFixed(sf)}(均${avg.toFixed(sf)})`;
      }
      const paramLines = Object.entries(skippedParamProfiles)
        .sort((a, b) => b[1].blocked - a[1].blocked)
        .map(([param, pf]) => {
          const curVal = param === "other" ? "?" : String(interceptParamsCache.get(param) ?? "?");
          let line = `  ${param}(阈值=${curVal}): 拦${pf.blocked}次 | 盈${pf.wouldWin}/亏${pf.wouldLose}/中${pf.neutral}`;
          if (pf.wouldWin > 0) {
            line += `\n    盈利被拦: RSI${fmtRange(pf.winRsis, false)} | 费率${fmtRange(pf.winFrs.map(f=>f*100), true)}% | 涨幅${fmtRange(pf.winPcts, true)}% | 被拦得分${fmtRange(pf.winScores, false)}`;
            if (pf.winScores.length > 0) {
              const winScoreHi = Math.max(...pf.winScores);
              const winScoreLo = Math.min(...pf.winScores);
              line += `\n    → 这${pf.wouldWin}笔盈利信号的被拦得分在${winScoreLo.toFixed(0)}~${winScoreHi.toFixed(0)}，若阈值≤${winScoreHi.toFixed(0)}可捕获`;
            }
          }
          if (pf.wouldLose > 0) {
            line += `\n    亏损被拦: RSI${fmtRange(pf.lossRsis, false)} | 费率${fmtRange(pf.lossFrs.map(f=>f*100), true)}% | 涨幅${fmtRange(pf.lossPcts, true)}% | 被拦得分${fmtRange(pf.lossScores, false)}`;
            if (pf.lossScores.length > 0) {
              const lossScoreLo = Math.min(...pf.lossScores);
              line += `\n    → 这${pf.wouldLose}笔亏损信号的被拦得分≥${lossScoreLo.toFixed(0)}，维持阈值≥${lossScoreLo.toFixed(0)}可继续过滤`;
            }
          }
          // 盈亏得分区间不重叠 → 可精准设置阈值
          if (pf.wouldWin > 0 && pf.wouldLose > 0 && pf.winScores.length > 0 && pf.lossScores.length > 0) {
            const winHi = Math.max(...pf.winScores);
            const lossLo = Math.min(...pf.lossScores);
            if (winHi < lossLo) {
              line += `\n    🎯 精准区间：盈利被拦 max=${winHi.toFixed(0)} < 亏损被拦 min=${lossLo.toFixed(0)}，建议阈值设在 ${winHi.toFixed(0)}~${lossLo.toFixed(0)} 之间`;
            } else {
              line += `\n    ⚠️ 盈亏得分重叠(盈${winHi.toFixed(0)}~亏${lossLo.toFixed(0)})，无法单靠此阈值完全分离，需结合其他参数过滤`;
            }
          }
          return line;
        });
      if (symLines.length > 0) {
        skippedAnalysis = "\n【被拦截信号回望评估】\n按参数(含盈亏特征画像，供精准调参):\n" + paramLines.join("\n\n") +
          "\n\n按币种:\n" + symLines.join("\n") +
          "\n\n建议：根据以上「盈亏被拦得分区间」，若盈利被拦得分明显低于亏损被拦得分(=区间不重叠)，则将阈值设于两区间之间。请据此给出 adjustIntercepts。";
      }
    }
    const fullDecAnalysis = decAnalysis + skippedAnalysis;
    const review = await aiTradeReview(tradeSummary, symbolStats, configStr, openSummary, btSummary, fullDecAnalysis);
    if (review && review.length > 10) {
      logger.info(`📊 AI 交易复盘(周期#${currentCycle}):\n${review}`);
      // 解析复盘结果，将 AI 建议回馈到策略引擎参数
      // 复盘建议是定性分析 → 翻译为量化参数调整
      try {
        const parsed = JSON.parse(review);
        // 1. 逐币种表现 → 调整评分乘数（连败币种降权）
        if (Array.isArray(parsed.bySymbol)) {
          applySymbolAnalysis(parsed.bySymbol);
        }
        // 1b. 基于历史胜率 → 自动调整仓位乘数（高胜率大仓位、低胜率小仓位）
        const historyTrades = db.prepare(
          "SELECT symbol, pnl, status FROM trades WHERE status = 'closed' ORDER BY id DESC LIMIT 500"
        ).all() as any[];
        applyWinRateReward(historyTrades);
        // 2. 信号类型 → 增加分数惩罚（追空/追涨扣分）
        if (parsed.blockSignals && typeof parsed.blockSignals === "string") {
          applyBlockSignals(parsed.blockSignals);
        }
        // 2b. 建议屏蔽的币种 → 降权（不复用冷启动的硬屏蔽）
        if (Array.isArray(parsed.blockSymbols)) {
          applyBlockSymbols(parsed.blockSymbols);
        }
        // 3. 全局建议 → 调整杠杆/止损/置信度
        if (Array.isArray(parsed.suggestions)) {
          applyReviewSuggestions(parsed.suggestions);
        }
        // 4. AI建议调整拦截参数（带阻尼：冷却+EMA平滑+最少交易数）
        if (Array.isArray(parsed.adjustIntercepts)) {
          const closedTrades = allTrades.filter((t: any) => t.status === "closed");
          // 虚拟成交：被拦信号 + 回望评估 → 也参与统计，打破「太保守→无数据→无法调参」的死锁
          const virtualTrades = Object.entries(skippedParamProfiles).reduce(
            (sum, [, s]) => sum + s.blocked, 0
          );
          const effectiveTrades = closedTrades.length + virtualTrades;
          const canAdjust = effectiveTrades >= PARAM_MIN_CLOSED_TRADES;
          for (const adj of parsed.adjustIntercepts) {
            if (adj.param && typeof adj.param === "string" && typeof adj.value === "number") {
              const cur = interceptParamsCache.get(adj.param);
              if (cur === undefined) continue;
              // 阻尼1: 最少闭环交易数（含虚拟成交）
              if (!canAdjust) {
                logger.info(`⚙️ 参数跳过: ${adj.param} 有效交易不足(成交${closedTrades.length}+虚${virtualTrades}=${effectiveTrades}<${PARAM_MIN_CLOSED_TRADES})`);
                continue;
              }
              // 阻尼2: 冷却期检查（同一参数至少隔6周期再调）
              const lastCycle = lastParamAdjustCycle.get(adj.param) || 0;
              if (currentCycle - lastCycle < PARAM_ADJUST_COOLDOWN_CYCLES) {
                logger.info(`⚙️ 参数跳过: ${adj.param} 冷却中(${currentCycle - lastCycle}/${PARAM_ADJUST_COOLDOWN_CYCLES}周期)`);
                continue;
              }
              // 阻尼3: EMA平滑，防AI反复横跳
              const smoothed = Math.round(cur * (1 - PARAM_EMA_ALPHA) + adj.value * PARAM_EMA_ALPHA);
              if (Math.abs(smoothed - cur) / Math.max(Math.abs(cur), 1) > 0.05) {
                const { updateInterceptParam } = await import("./db");
                updateInterceptParam(adj.param, smoothed);
                interceptParamsCache.set(adj.param, smoothed);
                lastParamAdjustCycle.set(adj.param, currentCycle);
                logger.info(`⚙️ AI调整拦截参数: ${adj.param} ${cur}→${smoothed}(EMA,建议${Math.round(adj.value)}) (${adj.reason || ""})`);
              }
            }
          }
          await loadInterceptParamsFromDb();
        }
        // 5. AI评分校准建议 → 存入状态供下次决策参考
        if (parsed.scoringAdvice && typeof parsed.scoringAdvice === "string") {
          const state = await import("./state");
          state.scoringAdvice = parsed.scoringAdvice;
          logger.info(`⚙️ 复盘→AI评分校准: ${parsed.scoringAdvice.slice(0, 80)}${parsed.scoringAdvice.length > 80 ? "..." : ""}`);
        }
        logger.info(`📊 复盘反馈已应用完成`);
        // 持久化到数据库，防止进程重启丢失
        saveFeedbackToDb().catch(() => {});
        // 评估未处理决策：对比决策时价格与当前价格
        try {
          const evalCount = evaluateUnjudgedDecisions(tickers);
          if (evalCount > 0) {
            logger.info(`📊 决策评估: 评估了 ${evalCount} 条未评估决策`);
          }
        } catch (e: any) {
          logger.warn(`[Evaluation] 异常: ${e.message}`);
        }
        // 运行 optimizer chain: 漂移检测 → combo发现 → 单指标优化 → 刷新缓存
        try {
          // 1. 概念漂移检测：发现失效规则
          const driftCount = detectRuleDrift();
          if (driftCount > 0) logger.info(`📉 规则漂移: ${driftCount} 条规则表现下滑`);
        } catch (e: any) { logger.warn(`[Drift] 异常: ${e.message}`); }
        try {
          // 2. 双指标组合发现: 多因子规律
          const comboCount = discoverComboPatterns();
          if (comboCount > 0) logger.info(`🔍 Combo发现: ${comboCount} 个双指标组合规律`);
        } catch (e: any) { logger.warn(`[Combo] 异常: ${e.message}`); }
        // 3. 行情变迁检测：ADX 趋势变化 >30% 则清空规则重学
        try {
          const adxVals = Array.from(indicatorCache.values()).filter(x => x.adx_1h > 0);
          if (adxVals.length > 0) {
            const avgAdx1h = adxVals.reduce((s, x) => s + x.adx_1h, 0) / adxVals.length;
            const avgAdx1d = adxVals.reduce((s, x) => s + x.adx_1d, 0) / adxVals.length;
            const shift = detectRegimeShift(avgAdx1h, avgAdx1d);
            if (shift.shifted) {
              const oldRegime = currentRegimeName;
              const newRegime = getOverallRegime();
              // 离开旧行情：保存当前参数快照
              if (oldRegime && oldRegime !== "unknown") {
                saveRegimeSnapshot(oldRegime);
                logger.info(`📸 行情变迁: 保存「${oldRegime}」参数快照 (${interceptParamsCache.size}个参数)`);
              }
              // 进入新行情：加载该行情的参数快照，或从默认值起步
              const savedParams = loadRegimeSnapshot(newRegime);
              if (savedParams.size > 0) {
                // 加载该行情以前存过的参数
                for (const [k, v] of savedParams) {
                  interceptParamsCache.set(k, v);
                }
                logger.info(`📸 行情变迁: 加载「${newRegime}」参数 (${savedParams.size}个参数)`);
              } else {
                // 首次进入该行情，用 DB 默认值
                await resetDynamicParams();
                // 保存一份空白快照（初始值）
                saveRegimeSnapshot(newRegime);
                logger.info(`📸 行情变迁: 首次进入「${newRegime}」，使用默认参数并创建快照`);
              }
              currentRegimeName = newRegime;
            }
          }
        } catch (e: any) { logger.warn(`[RegimeShift] 异常: ${e.message}`); }
        // 4. 单指标优化
        runOptimizer().then(rulesCreated => {
          if (rulesCreated > 0) {
            loadOptRulesFromDb().then(() => logger.info(`⚙️ 加载 ${optRulesCache.length} 条优化规则到缓存`));
          }
        }).catch((e: any) => logger.warn(`[Optimizer] 异常: ${e.message}`));
      } catch {}
      // 持久化到 DB
      const wins = allTrades.filter((t: any) => t.status === 'closed' && (t.pnl || 0) > 0).length;
      const closed = allTrades.filter((t: any) => t.status === 'closed').length;
      insertAiReview({
        time: new Date().toISOString(),
        cycle_number: currentCycle,
        summary: review.length > 200 ? review.slice(0, 200) + '...' : review,
        total_trades: allTrades.length,
        total_pnl: allTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0),
        win_rate: closed > 0 ? wins / closed : 0,
        full_report: review,
      });
      lastReviewCycle = currentCycle; // 成功后才标记
    } else {
      logger.info(`📊 AI 复盘(周期#${currentCycle})返回为空，${tradeSummary ? `${allTrades.length}笔交易` : '无交易数据'}`);
    }
  } catch (e: any) {
    logger.warn(`📊 AI 复盘(周期#${currentCycle})失败: ${e.message}，下周期重试`);
  }
}

main().catch((e) => {
  logger.error(`启动失败: ${e.message}`);
  process.exit(1);
});
