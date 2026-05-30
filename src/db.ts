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
    partial_close_pct REAL DEFAULT 0
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

export function updateDecisionStatus(id: number | bigint, status: string) {
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

export function closeTrade(id: number, exitPrice: number, exitQty: number, pnl: number, pnlPct: number, fee: number, closeType: string) {
  const now = new Date().toISOString();
  return db.prepare(`
    UPDATE trades SET exit_price=?, exit_qty=?, exit_time=?, pnl=?, pnl_pct=?, fee=?, status='closed', close_type=?
    WHERE id=?
  `).run(exitPrice, exitQty, now, pnl, pnlPct, fee, closeType, id);
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

// ========== 复盘反馈参数持久化 ==========
// feedback_state 表: 单行 JSON 存储 symbolScoreMult / signalScorePenalty / 标量参数
// 确保进程重启后反馈不丢失
db.exec(`CREATE TABLE IF NOT EXISTS feedback_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);

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
