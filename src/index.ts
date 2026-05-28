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
import { checkAccountRisk, checkStopLoss, executeStopLoss, getCurrentPrice, calcPnlPct, updatePeakEquity } from "./risk";
import { startServer, newCycle } from "./server";
import { setLatestReport, atrCache, rsiCache } from "./state";
import { aiDirectionCheck, type AiOpinion } from "./ai-check";
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
// 止损后暂停该币种交易的最小分钟数
const STOP_COOLDOWN_MINUTES = 30;
// 启动后等待 N 个周期再开新仓（让账户数据和 ATR 缓存稳定）
const STARTUP_COOLDOWN_CYCLES = 1;
// 每周期最多开 N 个新仓（按置信度排序后取头部）
const MAX_NEW_PER_CYCLE = 2;
// 本地已开仓集合（防 exchange.getPositions 延迟导致持仓上限失效）
const openedThisSession = new Set<string>();

async function main() {
  logger.info("=".repeat(50));
  logger.info("   SmartTrade — AI 多交易所合约交易系统");
  logger.info(`   监控: 每 ${MONITOR_INTERVAL / 1000}s | 策略决策: 每 ${DECISION_INTERVAL / 1000}s`);
  logger.info(`   账户止损: $${CONFIG.accountStopLossUsdt} | 跟踪止盈: 1.5%/0.6%→3%/0.5%`);
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
          new Promise((_, reject) => setTimeout(() => reject(new Error("决策超时")), DECISION_INTERVAL + 60_000)),
        ]);
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
      const openTrades = getOpenPositions() as any[];
      for (const p of positions) {
        try {
          await exchangeManager.closePosition(p.symbol, p.side, p.qty);
          // 同步写 DB
          const dbTrade = openTrades.find((t: any) => t.symbol === p.symbol);
          if (dbTrade) {
            closeTrade(dbTrade.id, 0, p.qty, p.unrealizedPnl || 0, p.unrealizedPnlPct || 0, 0, "account_stop");
          }
          peakPnlMap.delete(p.symbol);
          partialCloseMap.delete(p.symbol);
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
      const extMult = Math.abs(extDelta) / Math.max(extAtr * 100, 0.01);
      if (pos.side === "short" && extDelta < 0 && extMult >= 3 && extRsi < 30) {
        logger.warn(`⚠️ 超跌预警: ${pos.symbol} 偏离${Math.abs(extDelta).toFixed(1)}%×${extMult.toFixed(1)}ATR RSI${extRsi.toFixed(0)}, 谨防反弹`);
      } else if (pos.side === "long" && extDelta > 0 && extMult >= 3 && extRsi > 70) {
        logger.warn(`⚠️ 超涨预警: ${pos.symbol} 偏离${extDelta.toFixed(1)}%×${extMult.toFixed(1)}ATR RSI${extRsi.toFixed(0)}, 谨防回调`);
      }

      // 跟踪止盈：基于实际价格变化的 trailing stop
      //   核心：pnlPct 已含杠杆，除以杠杆还原为实际价格涨跌幅
      //   价格涨 ≥1.5% 时激活，保底 = 最高价格 - 0.6%
      //   价格涨 ≥3% 时缩窄到 0.5%，保底 = 最高价格 - 0.5%
      const trailLev = Math.max(pos.leverage || 1, 1);
      const pricePnl = pnlPct / trailLev;          // 当前实际价格涨跌%
      const peakPrice = peakPnl / trailLev;         // 历史最高价格涨跌%
      if (peakPrice >= 1.5 && pos.qty > 0) {
        const trailDist = peakPrice >= 3.0 ? 0.5 : 0.6;
        const floor = peakPrice - trailDist;
        if (pricePnl <= floor) {
          logger.warn(`🔄 跟踪止盈: ${pos.symbol} 价格峰值${peakPrice.toFixed(2)}%→${pricePnl.toFixed(2)}% 回撤${(peakPrice-pricePnl).toFixed(2)}%≥${trailDist}% 平仓${pos.qty}张`);
          try {
            const closeResult = await exchangeManager.closePosition(pos.symbol, pos.side, pos.qty);
            peakPnlMap.delete(key);
            partialCloseMap.delete(pos.symbol);
            closedThisCycle.add(pos.symbol);
            openedThisSession.delete(pos.symbol);
            if (dbTrade) {
              const exitPx = closeResult.avgPrice || currentPrice;
              const closeFee = closeResult.fee || 0;
              closeTrade(dbTrade.id, exitPx, pos.qty, pos.unrealizedPnl || 0, pnlPct, closeFee, "trail_stop");
            }
          } catch (e: any) {
            logger.error(`跟踪止盈失败 ${pos.symbol}: ${e.message}`);
          }
          continue;
        }
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
          const closeResult = await exchangeManager.closePosition(pos.symbol, pos.side, pos.qty);
          logger.warn(`  ✅ 止损平仓成功: ${pos.symbol} ${pos.qty}张`);
          stopCooldown.set(pos.symbol, Date.now());
          peakPnlMap.delete(key);
          partialCloseMap.delete(pos.symbol);
          closedThisCycle.add(pos.symbol);
          openedThisSession.delete(pos.symbol);
          if (dbTrade) {
            const closeFee = closeResult.fee || 0;
            closeTrade(dbTrade.id, closeResult.avgPrice || currentPrice, pos.qty,
              pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, closeFee, stopLossCheck.level);
          }
        } catch (e: any) {
          logger.error(`止损平仓失败 ${pos.symbol}: ${e.message}`);
        }
      }
    }

    // 双向同步
    const liveSymbols = new Set(positions.map(p => p.symbol));
    const dbOpen = (db.prepare(
      `SELECT * FROM trades WHERE status='open' AND (close_type IS NULL OR close_type = '')
       AND entry_time < datetime('now', '-30 seconds')`
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
    if (!lastSnapshotTime || now - lastSnapshotTime > 60000) {
      insertSnapshot({
        time: new Date().toISOString(),
        total_equity: account.totalEquity,
        unrealized_pnl: account.unrealizedPnl,
        realized_pnl_day: 0,
        margin_used: account.marginUsed,
        open_positions: positions.length,
      });
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
    let aiOpinions: Map<string, AiOpinion> | null = null;
    if (report.newTrades.length > 0) {
      const tickerSummary = Array.from(tickers.entries())
        .map(([sym, t]) => `${sym}:$${t.price}`).join(", ");
      aiOpinions = await aiDirectionCheck(report.newTrades, tickerSummary);
      if (aiOpinions && aiOpinions.size > 0) {
        const logStr = Array.from(aiOpinions.entries()).map(([s, d]) => `${s}:${d.direction}`).join(" ");
        logger.info(`🤖 AI 方向复核: ${logStr}`);
        // 注入 AI 理由到 summary
        const aiLines = Array.from(aiOpinions.entries())
          .map(([s, d]) => `${s}: ${d.direction === "agree" ? "✅" : d.direction === "disagree" ? "❌" : "➖"} ${d.reason}`)
          .join("\n");
        report.summary += `\n\n🤖 AI 审核:\n${aiLines}`;
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
            await exchangeManager.closePosition(posCmd.symbol, pos.side, pos.qty);
            updateDecisionStatus(decId, "success");
            logger.warn(`  ✅ AI 平仓: ${posCmd.symbol}`);
            peakPnlMap.delete(posCmd.symbol);
            openedThisSession.delete(posCmd.symbol);
            if (posCmd.reason.includes("离场")) {
              stopCooldown.set(posCmd.symbol, Date.now());
            }
            if (dbTrade) closeTrade(dbTrade.id, 0, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, 0, "ai_close");
          } catch (e: any) {
            updateDecisionStatus(decId, "failed");
            logger.error(`  平仓失败: ${e.message}`);
          }
        } else if (posCmd.action === "close_partial") {
          const clsPct = posCmd.closePercent || 50;
          const qty = Math.ceil(pos.qty * clsPct / 100);
          try {
            const closeResult = await exchangeManager.closePosition(posCmd.symbol, pos.side, qty);
            updateDecisionStatus(decId, "success");
            logger.warn(`  ✅ AI 部分平仓: ${posCmd.symbol} ${qty}张`);
            if (dbTrade) {
              const newPct = (dbTrade.partial_close_pct || 0) + clsPct;
              const partialPnl = closeResult.avgPrice > 0
                ? (pos.side === "long" ? (closeResult.avgPrice - pos.entryPrice) : (pos.entryPrice - closeResult.avgPrice)) * qty
                : 0;
              updatePartialClose(dbTrade.id, newPct, qty, partialPnl);
              logger.info(`💰 AI部分止盈: ${posCmd.symbol} ${qty}张 利润$${partialPnl.toFixed(2)} (累计${newPct}%)`);
              partialCloseMap.delete(posCmd.symbol);
              if (newPct >= 100) {
                openedThisSession.delete(posCmd.symbol);
                closeTrade(dbTrade.id, 0, pos.qty, pos.unrealizedPnl || 0, pos.unrealizedPnlPct || 0, 0, "ai_close_partial");
              }
            }
          } catch (e: any) {
            updateDecisionStatus(decId, "failed");
            logger.error(`  部分平仓失败: ${e.message}`);
          }
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
      for (const trade of report.newTrades) {
        if (openedThisCycle >= MAX_NEW_PER_CYCLE) { logger.info(`每周期最多开${MAX_NEW_PER_CYCLE}仓，已达上限`); break; }
        if (trade.action === "hold") continue;
        const regime = (trade as any).regime || "";
        const regimeThreshold = regime.startsWith("强趋势") ? 0.35 : regime.startsWith("弱趋势") ? 0.40 : regime.includes("震荡") ? 0.55 : 0.80;
        if ((trade.confidence || 0) < regimeThreshold) { 
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
        if (existingSymbols.has(trade.symbol)) { logger.info(`已有 ${trade.symbol} 持仓，跳过`); continue; }
        if (existingSymbols.size >= CONFIG.maxPositions) { logger.info(`持仓数已达上限 ${CONFIG.maxPositions}`); break; }
        // 止损冷却检查：该币种刚被止损，暂停指定分钟数
        if (stopCooldown.has(trade.symbol) && Date.now() - (stopCooldown.get(trade.symbol)||0) < STOP_COOLDOWN_MINUTES * 60000) {
          const mins = Math.ceil((STOP_COOLDOWN_MINUTES * 60000 - (Date.now() - (stopCooldown.get(trade.symbol)||0))) / 60000);
          logger.info(`⏸️ ${trade.symbol} 止损冷却中，${mins}分钟后恢复`);
          execLog.push(`cooldown:${trade.symbol}`);
          continue;
        }

        // AI 方向复核
        if (aiOpinions && aiOpinions.get(trade.symbol)?.direction === "disagree") {
          const msg = `⏭️ ${trade.symbol} AI 不认同方向，跳过`;
          logger.info(msg);
          execLog.push(msg);
          continue;
        }

        // 方向分散限制：同方向持仓不超过 5 个
        const tradeSide = trade.action === "buy" ? "long" : "short";
        const sameSideCount = positions.filter(p => p.side === tradeSide).length;
        const maxSameDir = 5;
        if (sameSideCount >= maxSameDir) {
          const msg = `⏭️ ${trade.symbol} 同方向已达${sameSideCount}/${maxSameDir}，分散风险跳过`;
          logger.info(msg);
          execLog.push(msg);
          continue;
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
        const margin = account.availableBalance * trade.amountPercent / 100;
        const ticker = tickers.get(trade.symbol);
        if (!ticker || ticker.price <= 0) { updateDecisionStatus(decId, "failed"); continue; }

        const contractSize = exchangeManager.getContractSize(trade.symbol);
        let qty = Math.max(1, Math.floor(margin * trade.leverage / (ticker.price * contractSize)));
        if (margin <= 0 || qty <= 0) {
          logger.warn(`⚠️ 保证金不足: 可用$${account.availableBalance.toFixed(2)}`);
          updateDecisionStatus(decId, "failed");
          continue;
        }

        try {
          const openResult = await exchangeManager.openPosition(trade.symbol, side, qty, trade.leverage);
          updateDecisionStatus(decId, "success");
          const fillPrice = openResult.avgPrice || ticker.price;
          const notional = qty * fillPrice * contractSize;
          insertTrade({
            exchange: CONFIG.exchanges[0], symbol: trade.symbol, side,
            leverage: trade.leverage, entry_price: fillPrice, entry_qty: qty,
            entry_time: new Date().toISOString(), reason: trade.reason,
            notional, margin: notional / trade.leverage,
            entry_fee: openResult.fee || 0,
          });
          logger.warn(`✅ 开仓: ${trade.symbol} ${side} ${qty}张 @$${fillPrice} ${trade.leverage}x`);
          existingSymbols.add(trade.symbol);
          openedThisSession.add(trade.symbol);
          openedThisCycle++;
          newPositionTime.set(trade.symbol, Date.now());
          // 逐笔延迟，避免 demo 环境瞬时并发触发限频
          await new Promise(r => setTimeout(r, 1500));
        } catch (e: any) {
          updateDecisionStatus(decId, "failed");
          logger.error(`开仓失败: ${e.message}`);
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
  } catch (e: any) {
    logger.error(`AI 决策异常: ${e.message}`);
  }
}

main().catch((e) => {
  logger.error(`启动失败: ${e.message}`);
  process.exit(1);
});
