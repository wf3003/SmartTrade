/**
 * SmartTrade - SQLite 数据库 (better-sqlite3)
 */
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { CONFIG } from "./config";
import { logger } from "./logger";
import path from "path";
import fs from "fs";

const dbPath = CONFIG.databaseUrl.replace("file:", "");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db: BetterSqlite3.Database = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    leverage INTEGER DEFAULT 5,
    entry_price REAL NOT NULL,
    entry_qty REAL NOT NULL,
    entry_time TEXT NOT NULL,
    exit_price REAL,
    exit_qty REAL,
    exit_time TEXT,
    pnl REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    fee REAL DEFAULT 0,
    status TEXT DEFAULT 'open',
    reason TEXT,
    close_type TEXT,
    partial_close_pct REAL DEFAULT 0,
    parent_id INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    ai_model TEXT NOT NULL,
    signal TEXT,
    symbol TEXT,
    action TEXT,
    leverage INTEGER,
    amount REAL,
    reason TEXT,
    confidence REAL,
    raw_response TEXT
  );

  CREATE TABLE IF NOT EXISTS account_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    total_equity REAL NOT NULL,
    unrealized_pnl REAL,
    realized_pnl_day REAL,
    margin_used REAL,
    open_positions INTEGER
  );

  CREATE TABLE IF NOT EXISTS exchange_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    time TEXT NOT NULL,
    realized_pnl REAL DEFAULT 0,
    fee REAL DEFAULT 0,
    exchange TEXT DEFAULT 'okx',
    pos_side TEXT DEFAULT ''
  );
`);

// 迁移：添加兼容字段
try { db.exec("ALTER TABLE decisions ADD COLUMN status TEXT DEFAULT 'pending'"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN notional REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN margin REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN peak_pnl_pct REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN entry_fee REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN partial_close_qty REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN partial_close_pnl REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trades ADD COLUMN parent_id INTEGER DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE indicator_snapshots ADD COLUMN regime TEXT DEFAULT 'unknown'"); } catch {}
try { db.exec("ALTER TABLE opt_rules ADD COLUMN regime TEXT DEFAULT 'all'"); } catch {}
// 回测日志（每个决策周期，每个币种一条）
db.exec(`
  CREATE TABLE IF NOT EXISTS backtest_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    symbol TEXT NOT NULL,
    optimal_strategy TEXT NOT NULL,
    adx_regime TEXT,
    rev_accuracy REAL,
    cont_accuracy REAL,
    confidence INTEGER,
    best_tf TEXT
  )
`);

// AI 交易复盘记录
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    cycle_number INTEGER NOT NULL,
    summary TEXT NOT NULL,
    total_trades INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    full_report TEXT
  );

  CREATE TABLE IF NOT EXISTS indicator_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER,
    trade_id INTEGER,
    time TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    regime TEXT DEFAULT 'unknown',
    rsi_1h REAL,
    rsi_1d REAL,
    adx_1h REAL,
    adx_1d REAL,
    atr_pct REAL,
    ema_dist_pct REAL,
    funding_rate REAL,
    volume_24h REAL,
    market_quality INTEGER,
    entry_quality INTEGER,
    leverage INTEGER,
    position_pct REAL,
    ai_confidence REAL,
    ai_score REAL,
    signal_type TEXT,
    result TEXT DEFAULT 'open',
    pnl REAL,
    close_type TEXT
  );

  CREATE TABLE IF NOT EXISTS opt_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    regime TEXT DEFAULT 'all',
    indicator TEXT NOT NULL,
    operator TEXT NOT NULL,
    val1 REAL NOT NULL,
    val2 REAL,
    impact_type TEXT NOT NULL,
    impact_value REAL NOT NULL,
    sample_size INTEGER DEFAULT 0,
    win_rate REAL,
    baseline_win_rate REAL,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );
`);
logger.info("数据库已连接: " + dbPath);

// 日期辅助函数
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

// 查询工具函数
export function getOpenPositions() {
  return db.prepare("SELECT * FROM trades WHERE status = 'open' AND (close_type IS NULL OR close_type = '')").all();
}

/** 获取每个币种最新的 open 记录（防重复 open 导致峰值写错行） */
export function getLatestOpenTrades(): Map<string, any> {
  const rows = db.prepare(`
    SELECT * FROM trades 
    WHERE status='open' AND id IN (
      SELECT MAX(id) FROM trades WHERE status='open' GROUP BY symbol
    )
  `).all() as any[];
  const map = new Map<string, any>();
  for (const r of rows) map.set(r.symbol, r);
  return map;
}

export function getTradesToday() {
  return db.prepare("SELECT * FROM trades WHERE entry_time >= ?").all(todayStr());
}

export function getDecisionsToday() {
  return db.prepare("SELECT * FROM decisions WHERE time >= ? ORDER BY id DESC LIMIT 50").all(todayStr());
}

export function getDecisionsHistory(days: number = 7) {
  return db.prepare("SELECT * FROM decisions WHERE time >= ? ORDER BY id DESC").all(daysAgoStr(days));
}

export function getTradesHistory(days: number = 7) {
  return db.prepare("SELECT * FROM trades WHERE entry_time >= ? ORDER BY id DESC").all(daysAgoStr(days));
}

export function getTradeStats(days: number = 7) {
  const since = daysAgoStr(days);
  const closed = db.prepare("SELECT * FROM trades WHERE status='closed' AND entry_time >= ?").all(since) as any[];
  const wins = closed.filter(t => (t.pnl || 0) > 0);
  const losses = closed.filter(t => (t.pnl || 0) <= 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const maxWin = closed.reduce((m, t) => Math.max(m, t.pnl || 0), 0);
  const maxLoss = closed.reduce((m, t) => Math.min(m, t.pnl || 0), 0);
  // 按币种统计
  const bySymbol: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of closed) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
    if ((t.pnl || 0) > 0) bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;
    bySymbol[t.symbol].pnl += t.pnl || 0;
  }
  const open = db.prepare("SELECT COUNT(*) as count FROM trades WHERE status='open' AND entry_time >= ?").get(since) as any;
  return {
    totalClosed: closed.length,
    totalOpen: open?.count || 0,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length * 100) : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    maxWin: Math.round(maxWin * 100) / 100,
    maxLoss: Math.round(maxLoss * 100) / 100,
    bySymbol,
  };
}

export function insertDecision(d: {
  time: string; ai_model: string; signal: string; symbol: string;
  action: string; leverage: number; amount: number; reason: string;
  confidence: number; raw_response: string;
}) {
  const info = db.prepare(`
    INSERT INTO decisions (time, ai_model, signal, symbol, action, leverage, amount, reason, confidence, raw_response, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(d.time, d.ai_model, d.signal, d.symbol, d.action, d.leverage, d.amount, d.reason, d.confidence, d.raw_response);
  return info.lastInsertRowid;
}

export function updateDecisionStatus(id: number | bigint, status: string, result?: string) {
  if (result) {
    return db.prepare("UPDATE decisions SET status = ?, raw_response = ? WHERE id = ?").run(status, result, id);
  }
  return db.prepare("UPDATE decisions SET status = ? WHERE id = ?").run(status, id);
}

export function insertTrade(t: {
  exchange: string; symbol: string; side: string; leverage: number;
  entry_price: number; entry_qty: number; entry_time: string; reason: string;
  notional?: number; margin?: number; entry_fee?: number;
}) {
  return db.prepare(`
    INSERT INTO trades (exchange, symbol, side, leverage, entry_price, entry_qty, entry_time, reason, status, notional, margin, entry_fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(t.exchange, t.symbol, t.side, t.leverage, t.entry_price, t.entry_qty, t.entry_time, t.reason, t.notional || 0, t.margin || 0, t.entry_fee || 0);
}

/** 流水账减仓记录（INSERT，不改原记录状态） */
export function insertPartialCloseRecord(t: {
  parent_id: number; exchange: string; symbol: string; side: string; leverage: number;
  entry_price: number; entry_qty: number; entry_time: string; reason: string;
  exit_price: number; exit_qty: number; pnl: number; pnl_pct: number; fee: number;
}) {
  return db.prepare(`
    INSERT INTO trades (exchange, symbol, side, leverage, entry_price, entry_qty, entry_time, reason, status,
      exit_price, exit_qty, exit_time, pnl, pnl_pct, fee, close_type, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial_closed', ?, ?, ?, ?, ?, ?, 'partial_close', ?)
  `).run(t.exchange, t.symbol, t.side, t.leverage, t.entry_price, t.entry_qty, t.entry_time, t.reason,
    t.exit_price, t.exit_qty, new Date().toISOString(), t.pnl, t.pnl_pct, t.fee, t.parent_id);
}

export function closeTrade(id: number, exitPrice: number, exitQty: number, pnl: number, pnlPct: number, fee: number, closeType: string) {
  const now = new Date().toISOString();
  return db.prepare(`
    UPDATE trades SET exit_price=?, exit_qty=?, exit_time=?, pnl=?, pnl_pct=?, fee=?, status='closed', close_type=?
    WHERE id=?
  `).run(exitPrice, exitQty, now, pnl, pnlPct, fee, closeType, id);
}

/** 从流水账减仓记录计算某笔交易的已减仓比例 */
export function getPartialClosePct(tradeId: number, totalQty: number): number {
  if (totalQty <= 0) return 0;
  const row = db.prepare(
    "SELECT COALESCE(SUM(entry_qty), 0) as closed FROM trades WHERE parent_id=? AND close_type='partial_close'"
  ).get(tradeId) as any;
  return Math.round((row?.closed || 0) / totalQty * 100);
}

export function updatePartialClose(id: number, pct: number, qty?: number, pnl?: number) {
  if (qty !== undefined && pnl !== undefined) {
    return db.prepare(
      "UPDATE trades SET partial_close_pct = ?, partial_close_qty = IFNULL(partial_close_qty, 0) + ?, partial_close_pnl = IFNULL(partial_close_pnl, 0) + ? WHERE id = ?"
    ).run(pct, qty, pnl, id);
  }
  return db.prepare("UPDATE trades SET partial_close_pct = ? WHERE id = ?").run(pct, id);
}

// ========== 交易所订单同步 ==========
const upsertOrder = db.prepare(`
  INSERT OR IGNORE INTO exchange_orders (order_id, symbol, side, qty, price, time, realized_pnl, fee, exchange, pos_side)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function syncExchangeOrders(orders: any[]) {
  let count = 0;
  for (const o of orders) {
    if (!o.id && !o.order_id) continue;
    const info = upsertOrder.run(
      o.id || o.order_id, o.symbol, o.side,
      Number(o.qty) || 0, Number(o.price) || 0,
      o.time || new Date().toISOString(),
      Number(o.realizedPnl) || 0, Number(o.fee) || 0,
      o.exchange || 'okx', o.posSide || ''
    );
    if (info.changes > 0) count++;
  }
  return count;
}

export function getExchangeOrders(limit: number = 50) {
  return db.prepare("SELECT * FROM exchange_orders ORDER BY id DESC LIMIT ?").all(limit);
}

export function insertSnapshot(s: {
  time: string; total_equity: number; unrealized_pnl: number;
  realized_pnl_day: number; margin_used: number; open_positions: number;
}) {
  return db.prepare(`
    INSERT INTO account_snapshots (time, total_equity, unrealized_pnl, realized_pnl_day, margin_used, open_positions)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(s.time, s.total_equity, s.unrealized_pnl, s.realized_pnl_day, s.margin_used, s.open_positions);
}

/** 加载未平仓持仓的峰值 PnL（重启恢复用，每币种只取最新一条） */
export function getOpenPositionPeakPnlMap(): Map<string, { tradeId: number; peakPnl: number }> {
  // 只取每个币种最新的一条 open 记录（防止旧仓位的峰值污染新仓位）
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.peak_pnl_pct FROM trades t
    INNER JOIN (
      SELECT symbol, MAX(id) AS max_id FROM trades WHERE status='open' GROUP BY symbol
    ) latest ON t.id = latest.max_id
    WHERE t.status='open' AND t.peak_pnl_pct > 0
  `).all() as any[];
  const map = new Map<string, { tradeId: number; peakPnl: number }>();
  for (const r of rows) {
    map.set(r.symbol, { tradeId: r.id, peakPnl: r.peak_pnl_pct });
  }
  return map;
}

/** 保存峰值 PnL 到数据库（持久化，防止重启丢失） */
export function updatePeakPnlInDb(id: number, peakPnlPct: number) {
  return db.prepare("UPDATE trades SET peak_pnl_pct = ? WHERE id = ?").run(peakPnlPct, id);
}

// ========== AI 复盘持久化 ==========
export function insertAiReview(r: {
  time: string; cycle_number: number; summary: string;
  total_trades: number; total_pnl: number; win_rate: number; full_report: string;
}) {
  return db.prepare(`
    INSERT INTO ai_reviews (time, cycle_number, summary, total_trades, total_pnl, win_rate, full_report)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(r.time, r.cycle_number, r.summary || "", r.total_trades, r.total_pnl, r.win_rate, r.full_report || "");
}

export function getRecentAiReviews(limit: number = 5) {
  return db.prepare("SELECT * FROM ai_reviews ORDER BY id DESC LIMIT ?").all(limit);
}

// ========== 回测日志持久化 ==========
export function insertBacktestLog(r: {
  time: string; symbol: string; optimalStrategy: string;
  adxRegime: string; revAccuracy: number; contAccuracy: number; confidence: number; bestTf: string;
}) {
  return db.prepare(`
    INSERT INTO backtest_logs (time, symbol, optimal_strategy, adx_regime, rev_accuracy, cont_accuracy, confidence, best_tf)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.time, r.symbol, r.optimalStrategy, r.adxRegime, r.revAccuracy, r.contAccuracy, r.confidence, r.bestTf);
}

export function getRecentBacktestLogs(symbol: string, limit: number = 30) {
  return db.prepare("SELECT * FROM backtest_logs WHERE symbol = ? ORDER BY id DESC LIMIT ?").all(symbol, limit);
}

// ========== 复盘反馈参数持久化 ==========
// feedback_state 表: 单行 JSON 存储 symbolScoreMult / signalScorePenalty / 标量参数
// 确保进程重启后反馈不丢失
db.exec(`CREATE TABLE IF NOT EXISTS feedback_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
db.exec(`
  CREATE TABLE IF NOT EXISTS decision_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL,
    snapshot_id INTEGER,
    eval_time TEXT NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    price_at_decision REAL,
    price_now REAL,
    price_change_pct REAL,
    evaluation TEXT NOT NULL,
    details TEXT
  );
`);

export function saveFeedbackState(data: string): void {
  db.prepare(`
    INSERT INTO feedback_state (id, data) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `).run(data);
}

export function loadFeedbackState(): string | null {
  const row = db.prepare("SELECT data FROM feedback_state WHERE id = 1").get() as any;
  return row?.data || null;
}

// ========== indicator_snapshots CRUD ==========
export function insertIndicatorSnapshot(s: {
  decision_id: number | null; trade_id: number | null; time: string;
  symbol: string; side: string; regime: string;
  rsi_1h: number | null; rsi_1d: number | null;
  adx_1h: number | null; adx_1d: number | null;
  atr_pct: number | null; ema_dist_pct: number | null;
  funding_rate: number | null; volume_24h: number | null;
  market_quality: number | null; entry_quality: number | null;
  leverage: number; position_pct: number;
  ai_confidence: number; ai_score: number;
  signal_type: string | null;
}): number | bigint {
  const info = db.prepare(`
    INSERT INTO indicator_snapshots
      (decision_id, trade_id, time, symbol, side, regime,
       rsi_1h, rsi_1d, adx_1h, adx_1d, atr_pct, ema_dist_pct,
       funding_rate, volume_24h, market_quality, entry_quality,
       leverage, position_pct, ai_confidence, ai_score, signal_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.decision_id, s.trade_id, s.time, s.symbol, s.side, s.regime,
    s.rsi_1h, s.rsi_1d, s.adx_1h, s.adx_1d, s.atr_pct, s.ema_dist_pct,
    s.funding_rate, s.volume_24h, s.market_quality, s.entry_quality,
    s.leverage, s.position_pct, s.ai_confidence, s.ai_score, s.signal_type,
  );
  return info.lastInsertRowid;
}

/** 平仓后更新 snapshot 的结果和盈亏 */
export function updateSnapshotResult(snapshotId: number | bigint, result: string, pnl: number | null, closeType: string | null): void {
  db.prepare(
    "UPDATE indicator_snapshots SET result = ?, pnl = ?, close_type = ? WHERE id = ?"
  ).run(result, pnl, closeType, snapshotId);
}

/** 设置 snapshot 的 trade_id（交易执行后回写） */
export function linkSnapshotToTrade(snapshotId: number | bigint, tradeId: number | bigint): void {
  db.prepare("UPDATE indicator_snapshots SET trade_id = ? WHERE id = ?").run(tradeId, snapshotId);
}

/** 获取所有已平仓的 snapshot（供 optimizer 统计） */
export function getClosedSnapshots(limit: number = 500): any[] {
  return db.prepare(
    "SELECT * FROM indicator_snapshots WHERE result != 'open' ORDER BY id DESC LIMIT ?"
  ).all(limit) as any[];
}

/** 获取近 N 天已平仓的 snapshots */
export function getClosedSnapshotsSince(sinceDays: number = 7, limit: number = 500): any[] {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  return db.prepare(
    "SELECT * FROM indicator_snapshots WHERE result != 'open' AND time >= ? ORDER BY id DESC LIMIT ?"
  ).all(since, limit) as any[];
}

// ========== 默认规则种子（新部署时写入） ==========
/** 当 opt_rules 表为空时，写入一批基于经验的默认规则 */
export function seedDefaultOptRules(): number {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM opt_rules WHERE active = 1").get() as any;
  if (count && count.cnt > 0) return 0;

  // 注意：默认规则仅放「方向无关」的通用保护。方向相关的规则（强趋势做空加分/降权等）
  // 由 optimizer 在实际运行中通过数据自动发现，避免先验偏差。
  const defaults: any[] = [
    // 资金费率极端 → 拥挤交易降权（已在代码硬编码中按方向处理，这里作为 DB 种子带元数据，供 optimizer 参考）
    { target: "score", regime: "all", indicator: "funding_rate", operator: "lt", val1: -0.03, impact_type: "multiply", impact_value: 0.4, sample_size: 8, win_rate: 22, baseline_win_rate: 61 },
    { target: "score", regime: "all", indicator: "funding_rate", operator: "gt", val1: 0.03, impact_type: "multiply", impact_value: 0.4, sample_size: 6, win_rate: 25, baseline_win_rate: 61 },
    // ATR 过高 → 波动率过大仓位减半
    { target: "position", regime: "all", indicator: "atr_pct", operator: "gt", val1: 5, impact_type: "multiply", impact_value: 0.5, sample_size: 12, win_rate: 40, baseline_win_rate: 61 },
    // Entry quality 低 → 降权（避免 AAVE 等入场时机差的交易，与 index.ts 的硬阻断互补）
    { target: "score", regime: "all", indicator: "entry_quality", operator: "lte", val1: 25, impact_type: "multiply", impact_value: 0.5, sample_size: 14, win_rate: 29, baseline_win_rate: 61 },
  ];

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO opt_rules (target, regime, indicator, operator, val1, val2, impact_type, impact_value,
      sample_size, win_rate, baseline_win_rate, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const r of defaults) {
    insert.run(r.target, r.regime, r.indicator, r.operator, r.val1, null,
      r.impact_type, r.impact_value, r.sample_size, r.win_rate, r.baseline_win_rate,
      now, now);
  }
  return defaults.length;
}

// ========== opt_rules CRUD ==========
export function upsertOptRule(r: {
  target: string; regime?: string; indicator: string; operator: string;
  val1: number; val2?: number;
  impact_type: string; impact_value: number;
  sample_size: number; win_rate: number; baseline_win_rate: number;
}): number | bigint {
  const reg = r.regime || "all";
  const existing = db.prepare(
    "SELECT id FROM opt_rules WHERE target = ? AND regime = ? AND indicator = ? AND operator = ? AND val1 = ? AND impact_type = ? AND active = 1"
  ).get(r.target, reg, r.indicator, r.operator, r.val1, r.impact_type) as any;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE opt_rules SET impact_value = ?, sample_size = ?, win_rate = ?, baseline_win_rate = ?,
        val2 = ?, updated_at = ?
      WHERE id = ?
    `).run(r.impact_value, r.sample_size, r.win_rate, r.baseline_win_rate, r.val2 ?? null, now, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO opt_rules (target, regime, indicator, operator, val1, val2, impact_type, impact_value,
      sample_size, win_rate, baseline_win_rate, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(r.target, reg, r.indicator, r.operator, r.val1, r.val2 ?? null,
    r.impact_type, r.impact_value, r.sample_size, r.win_rate, r.baseline_win_rate,
    now, now);
  return info.lastInsertRowid;
}

/** 获取所有活跃规则 */
export function getActiveOptRules(): any[] {
  return db.prepare("SELECT * FROM opt_rules WHERE active = 1 ORDER BY abs(impact_value) DESC").all() as any[];
}

/** 禁用一条规则（后续复盘发现该规则无效时） */
export function disableOptRule(id: number): void {
  db.prepare("UPDATE opt_rules SET active = 0, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

// ========== decision_evaluations CRUD ==========
export function insertDecisionEvaluation(e: {
  decision_id: number; snapshot_id: number | null; eval_time: string;
  symbol: string; action: string; status: string;
  price_at_decision: number | null; price_now: number | null;
  price_change_pct: number | null;
  evaluation: string; details: string | null;
}): number | bigint {
  const info = db.prepare(`
    INSERT INTO decision_evaluations
      (decision_id, snapshot_id, eval_time, symbol, action, status,
       price_at_decision, price_now, price_change_pct, evaluation, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.decision_id, e.snapshot_id, e.eval_time, e.symbol, e.action, e.status,
    e.price_at_decision, e.price_now, e.price_change_pct, e.evaluation, e.details,
  );
  return info.lastInsertRowid;
}

/** 获取还未评估的决策（返回某些必要字段，由调用方填充 ticker price） */
export function getUnevaluatedDecisions(): any[] {
  return db.prepare(`
    SELECT d.id, d.time, d.symbol, d.action, d.status, d.confidence, d.raw_response,
           s.id as snapshot_id
    FROM decisions d
    LEFT JOIN decision_evaluations e ON e.decision_id = d.id
    LEFT JOIN indicator_snapshots s ON s.decision_id = d.id
    WHERE e.id IS NULL AND d.status != 'pending'
    ORDER BY d.id DESC
    LIMIT 200
  `).all() as any[];
}

/** 获取所有评估记录（含指标快照，供 optimizer 统计分析） */
export function getAllEvaluations(limit: number = 500): any[] {
  return db.prepare(`
    SELECT e.*, s.regime, s.rsi_1h, s.rsi_1d, s.adx_1h, s.adx_1d, s.atr_pct, s.ema_dist_pct,
           s.funding_rate, s.volume_24h, s.market_quality, s.entry_quality,
           s.leverage, s.position_pct, s.ai_score, s.signal_type
    FROM decision_evaluations e
    LEFT JOIN indicator_snapshots s ON s.id = e.snapshot_id
    ORDER BY e.id DESC LIMIT ?
  `).all(limit) as any[];
}
