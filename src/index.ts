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
import { checkExtremeDeviation } from "./indicators";
import { checkAccountRisk, checkStopLoss, executeStopLoss, getCurrentPrice, calcPnlPct, updatePeakEquity } from "./risk";
import { startServer, newCycle } from "./server";
import { setLatestReport, atrCache, rsiCache, setCacheData, applyReviewSuggestions, applySymbolAnalysis, applyBlockSignals, applyBlockSymbols, resetDynamicParams, loadFeedbackFromDb, saveFeedbackToDb } from "./state";
import { aiDirectionCheck, type AiCheckResult, type AiOpinion, type AiPositionSuggestion } from "./ai-check";
import { aiTradeReview, buildTradeSummary, buildSymbolStats } from "./ai-review";
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
  updatePartialClose,
  getOpenPositionPeakPnlMap,
  updatePeakPnlInDb,
  getTradesHistory,
  insertAiReview,
} from "./db";

const MONITOR_INTERVAL = 2_000;  // 每 2 秒检查持仓
const DECISION_INTERVAL = 5 * 60_000; // 每 5 分钟策略决策
const MINIMUM_ACCOUNT_STOP_USDT = CONFIG.accountStopLossUsdt;

// 记录每个持仓的峰值盈利（用于移动止盈）
const peakPnlMap = new Map<string, number>();
// 记录本周期内每个持仓的已分批平仓比例（防重入）
const partialCloseMap = new Map<string, number>();
// 记录新开仓时间（防开仓瞬间止损）
const newPositionTime = new Map<string, number>();
// 止损平仓后冷却时间（防连续触发）
const stopCooldown = new Map<string, number>();
// 同一币种连续止损计数（递增惩罚）
const consecutiveStopCount = new Map<string, number>();
// 止损后暂停该币种交易的最小分钟数
const STOP_COOLDOWN_MINUTES = 15;
// 获取递增冷却时间（分钟）：第1次15分，第2次1h，第3次4h
function getDynamicCooldown(symbol: string): number {
  const cnt = consecutiveStopCount.get(symbol) || 0;
  if (cnt >= 3) return 4 * 60;   // 4小时
  if (cnt === 2) return 60;       // 1小时
  return STOP_COOLDOWN_MINUTES;   // 15分钟
}
// 启动后等待 N 个周期再开新仓（让账户数据和 ATR 缓存稳定）
const STARTUP_COOLDOWN_CYCLES = 1;
// 每周期最多开 N 个新仓（按置信度排序后取头部）
const MAX_NEW_PER_CYCLE = 10;
// 本地已开仓集合（防 exchange.getPositions 延迟导致持仓上限失效）
const openedThisSession = new Set<string>();

// ========== 统一开仓 / 关仓函数 ==========

/** 统一关仓：交易所平仓 → DB记录 → 状态清理 → 亏损冷却 */
async function executeFullClose(
  symbol: string,
  side: "long" | "short",
  qty: number,
  pnl: number,
  pnlPct: number,
  closeType: string,
): Promise<{ closeResult: any }> {
  const closeResult = await exchangeManager.closePosition(symbol, side, qty);
  // DB
  const dbTrade = getLatestOpenTrades().get(symbol);
  if (dbTrade) {
    const exitPrice = closeResult.avgPrice || 0;
    closeTrade(dbTrade.id, exitPrice, qty, pnl, pnlPct, closeResult.fee || 0, closeType);
  }
  // 状态清理
  peakPnlMap.delete(symbol);
  partialCloseMap.delete(symbol);
  openedThisSession.delete(symbol);
  // 亏损冷却
  if (pnlPct < 0) {
    const cnt = (consecutiveStopCount.get(symbol) || 0) + 1;
    consecutiveStopCount.set(symbol, cnt);
    const dynMin = getDynamicCooldown(symbol);
    stopCooldown.set(symbol, Date.now());
    logger.warn(`  ⏸️ ${symbol} 亏损平仓触发冷却 ${dynMin}分钟 (连续${cnt}次)`);
  }
  return { closeResult };
}

/** 统一部分平仓：记录分批比例，满100%后完成关闭 */
async function executePartialClose(
  symbol: string,
  side: "long" | "short",
  qty: number,
  closePercent: number,
  dbTrade: any,
): Promise<{ closeResult: any; newPct: number; partialPnl: number }> {
  const closeResult = await exchangeManager.closePosition(symbol, side, qty);
  const newPct = (dbTrade.partial_close_pct || 0) + closePercent;
  const partialPnl = closeResult.avgPrice > 0
    ? (side === "long" ? (closeResult.avgPrice - dbTrade.entry_price) : (dbTrade.entry_price - closeResult.avgPrice)) * qty
    : 0;
  updatePartialClose(dbTrade.id, newPct, qty, partialPnl);
  partialCloseMap.delete(symbol);
  if (newPct >= 100) {
    openedThisSession.delete(symbol);
    closeTrade(dbTrade.id, 0, dbTrade.entry_qty, 0, 0, closeResult.fee || 0, "ai_close_partial");
  }
  return { closeResult, newPct, partialPnl };
}

/** 统一开仓：交易所开仓 → DB插入 → 状态跟踪 */
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
    const openResult = await exchangeManager.openPosition(symbol, side, qty, leverage);
    updateDecisionStatus(decId, "success");
    const fillPrice = openResult.avgPrice || tickerPrice;
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

// 全局未捕获异常处理（防止决策超时等导致进程崩溃）
process.on("unhandledRejection", (reason) => {
  logger.error(`💥 未捕获的 Promise 异常: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`💥 未捕获的异常: ${err.message}`);
});

async function main() {
  // 重启恢复复盘反馈参数（避免失忆）
  await loadFeedbackFromDb();
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

    // 去重：同一币种只保留一条（OKX 有时逐仓/全仓各返回一条）
    const seenSymbols = new Set<string>();
    const uniquePositions = positions.filter(p => {
      if (seenSymbols.has(p.symbol)) return false;
      seenSymbols.add(p.symbol);
      return true;
    });

    // 本轮已平标记（止损/止盈关闭后，sync 不重复补建）
    const closedThisCycle = new Set<string>();

    // 逐笔检查持仓状态
    for (const pos of uniquePositions) {
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

      // 超涨/超跌预警：偏离 3 ATR + RSI 极端 → 日志提示
      const extAtr = atrCache.get(pos.symbol) || 0.015;
      const extRsi = rsiCache.get(pos.symbol) || 50;
      const extDelta = pnlPct / Math.max(pos.leverage || 1, 1);
      const extreme = checkExtremeDeviation(extDelta, extAtr * 100, extRsi, pos.side, 3);
      if (extreme.hit) {
        logger.warn(`⚠️ ${extreme.label}预警: ${pos.symbol} ${extreme.detail}, 谨防${extreme.label === "超跌反弹" ? "反弹" : "回调"}`);
      }

      // 跟踪止盈：价格涨 ≥0.8% 激活（原1.5%），保底0.4%（原0.6%），涨≥2%缩到0.3%（原3%/0.5%）
      const trailLev = Math.max(pos.leverage || 1, 1);
      const pricePnl = pnlPct / trailLev;          // 当前实际价格涨跌%
      const peakPrice = peakPnl / trailLev;         // 历史最高价格涨跌%
      if (peakPrice >= 0.8 && pos.qty > 0) {
        const trailDist = peakPrice >= 3.0 ? 0.8 : 1.0;
        const floor = peakPrice - trailDist;
        if (pricePnl <= floor) {
          logger.warn(`🔄 跟踪止盈: ${pos.symbol} 价格峰值${peakPrice.toFixed(2)}%→${pricePnl.toFixed(2)}% 回撤${(peakPrice-pricePnl).toFixed(2)}%≥${trailDist}% 平仓${pos.qty}张`);
          try {
            await executeFullClose(pos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pnlPct, "trail_stop");
            closedThisCycle.add(pos.symbol);
          } catch (e: any) {
            logger.error(`跟踪止盈失败 ${pos.symbol}: ${e.message}`);
          }
          continue;
        }
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

      // 止损检查：新开仓用宽止损 -15%，正常 ATR 动态止损
      if (stopCooldown.has(pos.symbol) && Date.now() - (stopCooldown.get(pos.symbol)||0) < 10000) continue; // 10秒冷却
      const atrVal = atrCache.get(pos.symbol) || 0.015;
      const stopLossCheck = isNewPosition
        ? (pnlPct <= -15 ? { shouldClose: true, level: "stop_loss", description: `新仓亏损${pnlPct.toFixed(1)}% 触发宽止损` } : null)
        : checkStopLoss(pnlPct, peakPnl, pos.leverage || 5, atrVal);
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
      if (!dbOpen.find((t: any) => t.symbol === pos.symbol)) {
        const existing = (db.prepare("SELECT id FROM trades WHERE symbol=? AND status='open' ORDER BY id DESC LIMIT 1").get(pos.symbol) as any);
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
        logger.warn(`🔧 同步: ${t.symbol} 交易所已无，关闭DB记录`);
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
    
    const report = await generateStrategyReport(tickers, ohlcvData, positions, account);
    if (!report) { logger.warn("策略未返回信号"); return; }
    setLatestReport(report);
    newCycle();

    // 5a. AI 方向复核（每周期一次）
    let aiResult: AiCheckResult | null = null;
    // AI 方向复核（每周期一次）
    const tickerIndicators = Array.from(tickers.entries())
      .map(([sym, t]) => {
        const atr = (atrCache.get(sym) || 0.015) * 100;
        const rsi = rsiCache.get(sym) || 50;
        const analysis = report.analysis?.find((a: any) => a.symbol === sym);
        return `${sym}:$${t.price} RSI${rsi.toFixed(0)} ATR${atr.toFixed(2)}% ${analysis?.analysis_1d || ""} ${analysis?.summary ? ("| " + analysis.summary) : ""}`;
      }).join("\n");
    // 持仓数据：合并交易所持仓 + 策略分析（让AI能基于趋势/RSI/策略判断该不该平仓）
    const posLines = positions.length > 0
      ? positions.map(p => {
          const analysis = report.analysis?.find((a: any) => a.symbol === p.symbol);
          const atr = (atrCache.get(p.symbol) || 0.015) * 100;
          const rsi = rsiCache.get(p.symbol) || 50;
          const pc = report.positions?.find((c: any) => c.symbol === p.symbol);
          const stratAdvice = pc && pc.action !== "hold" ? ` [策略建议:${pc.action} ${pc.reason}]` : "";
          return `${p.symbol} ${p.side} PnL:${(p.unrealizedPnlPct||0).toFixed(1)}% 杠杆${p.leverage}x | RSI${rsi.toFixed(0)} ATR${atr.toFixed(1)}% | 趋势:${analysis?.trend||"?"}(${analysis?.strength||"?"})${stratAdvice}`;
        }).join("\n")
      : "无";
    aiResult = await aiDirectionCheck(report.newTrades, tickerIndicators, posLines);
    if (aiResult) {
      if (aiResult.signals.size > 0) {
        const logStr = Array.from(aiResult.signals.entries()).map(([s, d]) => `${s}:评分${d.score}`).join(" | ");
        logger.info(`🤖 AI 方向复核: ${logStr}`);
        for (const [s, d] of aiResult.signals.entries()) {
          logger.info(`   ${s}: 评分${d.score} — ${d.reason}`);
        }
      }
      if (aiResult.positions.length > 0) {
        const posAct = aiResult.positions.filter(p => p.action !== "hold");
        for (const p of posAct) {
          logger.warn(`🤖 AI 持仓建议: ${p.symbol} → ${p.action} ${p.closePercent ? p.closePercent+"%" : ""} — ${p.reason}`);
        }
        const holdCnt = aiResult.positions.filter(p => p.action === "hold").length;
        logger.info(`🤖 AI 持仓评估: ${aiResult.positions.length}个, ${posAct.length}个非hold, ${holdCnt}个hold`);
      }
      // 注入 AI 结果到前端
      const aiReviewArr: any[] = [];
      for (const [s, d] of aiResult.signals.entries()) {
        aiReviewArr.push({ symbol: s, score: d.score, reason: d.reason });
      }
      (report as any).aiReview = aiReviewArr;
      if (aiResult.positions.length > 0) {
        (report as any).aiPositions = aiResult.positions;
      }
    }

    // 5. 处理持仓管理指令（来自 AI）
    if (report.positions && report.positions.length > 0) {
      for (const posCmd of report.positions) {
        const pos = positions.find(p => p.symbol === posCmd.symbol);
        // 记录决策（即使持仓已不存在也要写，防"待执行"漏掉）
        const decId = insertDecision({
          time: new Date().toISOString(),
          ai_model: CONFIG.ai.model, signal: `pos-${posCmd.action}`,
          symbol: posCmd.symbol, action: posCmd.action, leverage: pos?.leverage || CONFIG.defaultLeverage,
          amount: posCmd.closePercent || 100, reason: posCmd.reason,
          confidence: posCmd.confidence || 0.7, raw_response: JSON.stringify(posCmd),
        });

        if (!pos) {
          logger.info(`📋 AI 持仓决策: ${posCmd.symbol} → 持仓已不在 (${posCmd.reason})`);
          updateDecisionStatus(decId, "success");
          continue;
        }

        logger.info(`📋 AI 持仓决策: ${posCmd.symbol} → ${posCmd.action} (${posCmd.reason})`);

        // 查找 DB 中的持仓记录，关闭后同步交易记录
        const dbTrade = (getOpenPositions() as any[]).find((t: any) => t.symbol === posCmd.symbol);

        if (posCmd.action === "close") {
          try {
            await executeFullClose(posCmd.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, "ai_close");
            updateDecisionStatus(decId, "success");
            logger.warn(`  ✅ AI 平仓: ${posCmd.symbol}`);
          } catch (e: any) {
            updateDecisionStatus(decId, "failed");
            logger.error(`  平仓失败: ${e.message}`);
          }
        } else if (posCmd.action === "close_partial") {
          const clsPct = posCmd.closePercent || 50;
          const qty = Math.ceil(pos.qty * clsPct / 100);
          try {
            const { newPct, partialPnl } = await executePartialClose(posCmd.symbol, pos.side, qty, clsPct, dbTrade);
            updateDecisionStatus(decId, "success");
            logger.warn(`  ✅ AI 部分平仓: ${posCmd.symbol} ${qty}张 利润$${partialPnl.toFixed(2)} (累计${newPct}%)`);
          } catch (e: any) {
            updateDecisionStatus(decId, "failed");
            logger.error(`  部分平仓失败: ${e.message}`);
          }
        }
      }
    }

    // 5b. AI 主动平仓（智能执行）
    //   条件：持仓 > 30分钟（防开仓瞬间被AI关）；AI建议平仓不需要检查PnL
    //   AI认为该平仓时（如RSI超卖趋势衰竭），即使亏损也应执行
    if (aiResult?.positions) {
      for (const aiPos of aiResult.positions) {
        if (aiPos.action === "hold") continue;
        const pos = positions.find(p => p.symbol === aiPos.symbol);
        if (!pos) continue;
        const posAge = newPositionTime.has(pos.symbol)
          ? (Date.now() - (newPositionTime.get(pos.symbol) || 0)) / 60000
          : 999;
        const dbTrade = (getOpenPositions() as any[]).find((t: any) => t.symbol === pos.symbol);
        // 保护条件：仅持仓 < 30分钟时只预警不平仓（防开仓瞬间被AI关）
        if (posAge < 30) {
          logger.warn(`🤖 AI 预警: ${aiPos.symbol} → ${aiPos.action} ${posAge.toFixed(0)}分 PnL${(pos.unrealizedPnlPct||0).toFixed(1)}% | ${aiPos.reason} (太新，仅提示)`);
          continue;
        }
        // 执行平仓
        try {
          if (aiPos.action === "close") {
            await executeFullClose(aiPos.symbol, pos.side, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, "ai_close");
            logger.warn(`🤖 AI 平仓: ${aiPos.symbol} ${pos.qty}张 — ${aiPos.reason}`);
          } else {
            const qty = Math.ceil(pos.qty * (aiPos.closePercent || 50) / 100);
            await executePartialClose(aiPos.symbol, pos.side, qty, aiPos.closePercent || 50, dbTrade);
            logger.warn(`🤖 AI 平仓: ${aiPos.symbol} ${qty}张 — ${aiPos.reason}`);
          }
        } catch (e: any) {
          logger.error(`AI平仓失败 ${aiPos.symbol}: ${e.message}`);
        }
      }
    }

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
        if (trade.action === "hold") continue;
        (report as any).tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "启动保护中" });
      }
    } else if (report.newTrades && report.newTrades.length > 0) {
      const actionable = report.newTrades
        .filter(t => t.action !== "hold")
        .sort((a, b) => (Math.abs(b.score || 0)) - (Math.abs(a.score || 0)));
      if (actionable.length === 0) {
        logger.info(`📋 本轮决策无开仓 (${report.newTrades.length}条均为hold)`);
        execLog.push("AI 全部观望，无开仓");
      } else if (risk.accountStop || !risk.allowOpen) {
        const reason = risk.reason || "未知原因";
        logger.warn(`⚠️ 风控阻止开仓: ${reason}`);
        execLog.push(`风控阻止: ${reason}`);
        // 记录被风控跳过的新开仓尝试
        for (const trade of report.newTrades) {
          if (trade.action === "hold") continue;
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
        if (trade.action === "hold") continue;
        const regime = (trade as any).regime || "";
        const regimeThreshold = regime.startsWith("强趋势") ? 0.35 : regime.startsWith("弱趋势") ? 0.40 : regime.includes("震荡") ? 0.55 : 0.80;
        if ((trade.confidence || 0) < regimeThreshold) { 
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `信心度不足(${((trade.confidence||0)*100).toFixed(0)}%<${(regimeThreshold*100).toFixed(0)}%)` });
          const msg = `⏭️ ${trade.symbol} 信心度${((trade.confidence||0)*100).toFixed(0)}% < ${(regimeThreshold*100).toFixed(0)}%(${regime||"-"}) 跳过`;
          logger.info(msg);
          execLog.push(msg);
          const skipId = insertDecision({
            time: new Date().toISOString(), ai_model: CONFIG.ai.model,
            signal: trade.action, symbol: trade.symbol, action: trade.action,
            leverage: trade.leverage, amount: trade.amountPercent,
            reason: trade.reason, confidence: trade.confidence,
            raw_response: JSON.stringify(trade),
          });
          updateDecisionStatus(skipId, "skipped");
          continue; 
        }
        if (existingSymbols.has(trade.symbol)) { tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "已有持仓" }); logger.info(`已有 ${trade.symbol} 持仓，跳过`); continue; }
        if (existingSymbols.size >= CONFIG.maxPositions) { tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: "持仓数已达上限" }); logger.info(`持仓数已达上限 ${CONFIG.maxPositions}`); break; }
        // 止损冷却检查：递增惩罚
        const dynMin = getDynamicCooldown(trade.symbol);
        const dynMs = dynMin * 60000;
        if (stopCooldown.has(trade.symbol) && Date.now() - (stopCooldown.get(trade.symbol)||0) < dynMs) {
          const mins = Math.ceil((dynMs - (Date.now() - (stopCooldown.get(trade.symbol)||0))) / 60000);
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `止损冷却${mins}分钟` });
          logger.info(`⏸️ ${trade.symbol} 止损冷却中，${mins}分钟/${dynMin}总 (连续${consecutiveStopCount.get(trade.symbol) || 1}次)`);
          execLog.push(`cooldown:${trade.symbol}`);
          continue;
        }

        // AI 评分过滤：0-20跳过，20-40四分之一仓，40-70半仓，70+全仓
        // 策略评分 |score|≥12 时降低AI评分门槛（强趋势信号放宽过滤）
        // 但即使绕过也要求 aiScore ≥ 20，AI完全不认同的信号不开
        const aiScore = aiResult?.signals.get(trade.symbol)?.score ?? 70;
        const bypassAi = Math.abs(trade.score || 0) >= 12;
        if (aiScore < 20) {
          const aiRsn = aiResult?.signals.get(trade.symbol)?.reason || "评分不足";
          const msg = `⏭️ ${trade.symbol} AI 评分${aiScore}<20，跳过 (${aiRsn})`;
          tradeResults.push({ symbol: trade.symbol, status: "ai_rejected", reason: `AI评分${aiScore}: ${aiRsn}` });
          logger.info(msg);
          execLog.push(msg);
          continue;
        }
        if (!bypassAi && aiScore < 40) {
          // 四分之一仓
          trade.amountPercent = Math.round(trade.amountPercent / 4);
          logger.info(`   ${trade.symbol} AI 评分${aiScore}，仓位降至1/4=${trade.amountPercent}%`);
        } else if (!bypassAi && aiScore < 70) {
          // 半仓
          trade.amountPercent = Math.round(trade.amountPercent / 2);
          logger.info(`   ${trade.symbol} AI 评分${aiScore}，仓位减半至${trade.amountPercent}%`);
        }
        if (bypassAi) {
          logger.info(`   ${trade.symbol} 策略评分|${trade.score}|≥12，绕过AI评分过滤 (AI评分${aiScore})`);
        }

        // 行情质量：规则 mq + AI marketQuality 取平均
        const ruleMq = (trade as any).marketQuality ?? 50;
        const aiMq = aiResult?.marketQuality ?? 50;
        const finalMq = Math.round((ruleMq + aiMq) / 2);
        if (finalMq < 20) {
          const msg = `⏭️ ${trade.symbol} 综合行情质量${finalMq}<20，跳过 (规则${ruleMq} AI${aiMq})`;
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `行情质量低(${finalMq})` });
          logger.info(msg);
          execLog.push(msg);
          continue;
        } else if (finalMq < 40) {
          trade.amountPercent = Math.round(trade.amountPercent * 0.5);  // 再减半
          trade.leverage = Math.max(2, trade.leverage - 2);
          logger.info(`   ${trade.symbol} 综合行情质量${finalMq}，仓位再减半至${trade.amountPercent}%，杠杆降至${trade.leverage}x`);
        } else if (finalMq < 70) {
          trade.amountPercent = Math.round(trade.amountPercent * 0.75); // 减1/4
          logger.info(`   ${trade.symbol} 综合行情质量${finalMq}，仓位降至${trade.amountPercent}%`);
        }

        logger.warn(`🤖 AI 开仓: ${trade.action} ${trade.symbol} | ${trade.leverage}x | ${trade.amountPercent}%`);
        logger.info(`   理由: ${trade.reason}`);

        const decId = insertDecision({
          time: new Date().toISOString(), ai_model: CONFIG.ai.model,
          signal: trade.action, symbol: trade.symbol, action: trade.action,
          leverage: trade.leverage, amount: trade.amountPercent,
          reason: trade.reason, confidence: trade.confidence,
          raw_response: JSON.stringify(trade),
        });

        const side = trade.action === "buy" ? "long" : "short";
        const margin = Number(account.availableBalance) * trade.amountPercent / 100;
        const ticker = tickers.get(trade.symbol);
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
          // 逐笔延迟，避免 demo 环境瞬时并发触发限频
          await new Promise(r => setTimeout(r, 1500));
        } else {
          tradeResults.push({ symbol: trade.symbol, status: "skipped", reason: `开仓失败: ${error || "未知"}` });
        }
      }
      }
    }
    if (execLog.length > 0 && report.execution) report.execution.log = execLog;

    if (report.analysis?.length) {
      const top = report.analysis.filter(a => Math.abs(a.score) >= 6).slice(0, 3);
      for (const a of top) {
        logger.info(`  📊 ${a.symbol}: ${a.trend}(${a.strength}) score:${a.score} — ${a.summary?.slice(0, 60)}`);
      }
    }

    // 6. AI 交易复盘（每 6 周期≈30 分钟一次，独立定时器，不阻塞决策循环）
    scheduleReview(aiCycleNumber);
  } catch (e: any) {
    logger.error(`AI 决策异常: ${e.message}`);
  }
}

/** 独立复盘定时器：每 6 周期≈30分钟触发一次，不阻塞决策主流程 */
let lastReviewCycle = 0;
async function scheduleReview(currentCycle: number) {
  if (currentCycle % 6 !== 0 || currentCycle === lastReviewCycle) return;
  try {
    const allTrades = getTradesHistory(7) as any[];
    const tradeSummary = buildTradeSummary(allTrades);
    const symbolStats = buildSymbolStats(allTrades);
    const configStr = `杠杆:${CONFIG.defaultLeverage}x 止损:5-10% 跟踪:0.8%/0.4%→2%/0.3%`;
    logger.info(`📊 AI 复盘(周期#${currentCycle})开始调用...`);
    const review = await aiTradeReview(tradeSummary, symbolStats, configStr);
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
        logger.info(`📊 复盘反馈已应用完成`);
        // 持久化到数据库，防止进程重启丢失
        saveFeedbackToDb().catch(() => {});
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
