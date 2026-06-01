import Database from "better-sqlite3";
const db = new Database("./data/quantmax.db");

// 所有ai_close平仓按时间排列
const trades = db.prepare(`
  SELECT id, symbol, side, entry_price, exit_price, pnl, pnl_pct, close_type, status, entry_time, exit_time
  FROM trades WHERE status='closed' AND close_type='ai_close'
  ORDER BY id
`).all();

console.log("=== AI决策平仓全纪录 (按时间) ===\n");
let totalPnl = 0, lossCount = 0, winCount = 0, totalCount = 0;
for (const t of trades) {
  totalCount++;
  const pnl = t.pnl || 0;
  const pnlPct = t.pnl_pct || 0;
  totalPnl += pnl;
  if (pnl < 0) lossCount++; else winCount++;
  const sign = pnl >= 0 ? "+" : "";
  console.log(`#${t.id} ${String(t.symbol || '').padEnd(10)} ${String(t.side || '').padEnd(6)} entry=$${(t.entry_price||0).toFixed(2)} pnl=${sign}${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) ${t.entry_time?.slice(11,16)||''}`);
}

console.log(`\n=== 汇总 ===`);
console.log(`总平仓: ${totalCount}次`);
console.log(`盈利: ${winCount}次 亏损: ${lossCount}次`);
console.log(`总盈亏: $${totalPnl.toFixed(2)}`);
console.log(`胜率: ${(winCount/totalCount*100).toFixed(0)}%`);

// 检查close_position返回的avgPrice
console.log(`\n=== exit_price分布 ===`);
const exitZeros = trades.filter(t => !t.exit_price || t.exit_price === 0).length;
const exitNonZero = trades.filter(t => t.exit_price && t.exit_price > 0).length;
console.log(`exit_price=0: ${exitZeros}次`);
console.log(`exit_price>0: ${exitNonZero}次`);

// 查看冷却是否被触发过（搜索decisions）
try {
  const coolingDecs = db.prepare(`
    SELECT symbol, reason, time FROM decisions 
    WHERE reason LIKE '%冷却%' OR reason LIKE '%cooldown%'
    ORDER BY id DESC LIMIT 10
  `).all();
  if (coolingDecs.length > 0) {
    console.log(`\n=== 冷却相关决策 ===`);
    for (const d of coolingDecs) {
      console.log(`  ${d.symbol}: ${d.reason} ${d.time?.slice(11,16)}`);
    }
  } else {
    console.log(`\n⚠️ 数据库中没有冷却相关决策记录`);
  }
} catch(e) { console.log(`decisions表查询失败`); }

db.close();
