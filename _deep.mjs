import Database from 'better-sqlite3';

for (const dbPath of ['/home/rose/SmartTrade/data/quantmax.db', '/home/rose/SmartTrade2/data/quantmax.db']) {
  const label = dbPath.includes('SmartTrade2') ? '2号' : '1号';
  const db = new Database(dbPath, { readonly: true });
  
  // backtest logs
  const bt = db.prepare("SELECT * FROM backtest_logs ORDER BY time").all();
  console.log(`\n=== ${label} 回测日志 (${bt.length}条) ===`);
  
  const btBySym = {};
  for (const r of bt) {
    const s = r.symbol.replace('/USDT','');
    if (!btBySym[s]) btBySym[s] = [];
    btBySym[s].push(r);
  }
  for (const [sym, list] of Object.entries(btBySym)) {
    const revs = list.map(r => r.rev_accuracy).filter(v => v != null);
    const conts = list.map(r => r.cont_accuracy).filter(v => v != null);
    const revAvg = revs.length ? revs.reduce((a,b)=>a+b,0)/revs.length : 0;
    const contAvg = conts.length ? conts.reduce((a,b)=>a+b,0)/conts.length : 0;
    // Look at optimal strategy chosen
    const chosen = list.map(r => r.optimal_strategy);
    const revPicks = chosen.filter(c => c === 'rev').length;
    const contPicks = chosen.filter(c => c === 'cont').length;
    console.log(`  ${sym.padEnd(6)}: 反转${revAvg.toFixed(0)}% vs 延续${contAvg.toFixed(0)}% (选择: 反转${revPicks}次 延续${contPicks}次)`);
  }
  
  // trades
  const trades = db.prepare("SELECT * FROM trades WHERE status = 'closed' AND exit_price IS NOT NULL ORDER BY entry_time").all();
  let cum = 0, hi = 0, maxDD = 0;
  for (const t of trades) { cum += t.pnl; if (cum > hi) hi = cum; const dd = hi - cum; if (dd > maxDD) maxDD = dd; }
  console.log(`\n交易: ${trades.length}笔 | 总盈亏: $${cum.toFixed(2)} | 峰值: $${hi.toFixed(2)} | 最大回撤: $${maxDD.toFixed(2)} (${hi>0?(maxDD/hi*100).toFixed(1):0}%)`);
  
  // AI reviews  
  const reviews = db.prepare("SELECT * FROM ai_reviews ORDER BY id").all();
  if (reviews.length) {
    console.log(`\nAI复盘 (${reviews.length}条):`);
    for (const r of reviews) {
      console.log(`  #${r.id} ${(r.time||'').substring(0,16)} | ${r.total_trades||0}笔 PnL:$${(r.total_pnl||0).toFixed(2)} 胜率:${(r.win_rate||0).toFixed(0)}%`);
      if (r.summary) console.log(`    摘要: ${r.summary.substring(0,120)}`);
    }
  }
  
  // decisions summary
  const decs = db.prepare("SELECT action, COUNT(*) as cnt FROM decisions GROUP BY action ORDER BY cnt DESC").all();
  console.log(`\nAI决策分布: ${decs.map(d=>d.action+':'+d.cnt).join(' | ')}`);
  
  db.close();
}
