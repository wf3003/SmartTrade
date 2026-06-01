import Database from "better-sqlite3";
const db = new Database("./data/quantmax.db");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

const tcols = db.prepare("PRAGMA table_info(trades)").all();
console.log("\ntrades:", tcols.map(c => `${c.name}(${c.type})`).join(", "));

const trades = db.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 30").all();
console.log("\n=== 最近30条交易 ===");
for (const t of trades) {
  console.log(`#${t.id} ${t.symbol} ${t.side} ${t.status} entry=$${t.entry_price} qty=${t.entry_qty} lev=${t.leverage} exit=$${t.exit_price||'-'} pnl=$${t.pnl||'-'} pnl%=${t.pnl_pct||'-'} close=${t.close_type||'-'} time=${t.entry_time?.slice(5,16)||''}`);
}

const ctStats = db.prepare(`
  SELECT close_type, COUNT(*) as cnt, ROUND(AVG(pnl_pct),2) as avgPnl, ROUND(AVG(pnl),2) as avgPnlD, SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
  FROM trades WHERE status='closed' AND close_type IS NOT NULL AND close_type != ''
  GROUP BY close_type ORDER BY cnt DESC
`).all();
console.log("\n=== 按平仓类型统计 ===");
for (const r of ctStats) {
  console.log(`  ${(r.close_type||'').padEnd(16)} ${r.cnt}次  平均盈亏${r.avgPnl}% 亏损${r.losses}次`);
}

const revTrades = db.prepare(`
  SELECT * FROM trades 
  WHERE status='closed' AND close_type='ai_close'
  ORDER BY id DESC LIMIT 20
`).all();
console.log("\n=== AI决策平仓明细 ===");
for (const t of revTrades) {
  console.log(`#${t.id} ${t.symbol} ${t.side} entry=$${t.entry_price} exit=$${t.exit_price} pnl=${t.pnl_pct}% type=${t.close_type}`);
}

db.close();
