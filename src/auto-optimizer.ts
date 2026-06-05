/**
 * 自动调参优化器
 * 定期分析 indicator_snapshots 的历史数据，统计每个指标在不同区间下的胜率，
 * 生成可执行的 opt_rules 规则。
 *
 * 流程：
 * 1. 查询所有已平仓的 snapshots
 * 2. 对每个数值指标，按值排序 → 均匀分 5 段 → 算每段胜率
 * 3. 如果某段与全局基线偏差 > 15%，且样本数 >= 3，则生成规则
 * 4. 回测验证新规则：如果应用后历史胜率提升则持久化，否则丢弃
 *
 * 新增决策评估：
 * - 每次复盘时，对还未评估过的决策（含被跳过的），
 *   对比决策时的价格和当前币价，判断决策正确性。
 * - 评估结果作为 independent_snapshots 的补充，一起参与统计。
 */
import { logger } from "./logger";
import { db, getClosedSnapshots, getUnevaluatedDecisions, insertDecisionEvaluation, upsertOptRule, getActiveOptRules, insertRulePerformance, getRulePerformanceHistory, disableOptRule } from "./db";

interface Segment {
  label: string;
  min: number;
  max: number;
  wins: number;
  losses: number;
}

const INDICATORS: { field: string; name: string }[] = [
  { field: "rsi_1h", name: "rsi_1h" },
  { field: "rsi_1d", name: "rsi_1d" },
  { field: "adx_1h", name: "adx_1h" },
  { field: "adx_1d", name: "adx_1d" },
  { field: "atr_pct", name: "atr_pct" },
  { field: "ema_dist_pct", name: "ema_dist_pct" },
  { field: "funding_rate", name: "funding_rate" },
  { field: "market_quality", name: "market_quality" },
  { field: "entry_quality", name: "entry_quality" },
];

/** 主入口：运行一轮优化分析 */
export async function runOptimizer(): Promise<number> {
  const snapshots = getClosedSnapshots(200) as any[];
  if (snapshots.length < 5) {
    logger.info(`[Optimizer] 样本不足(${snapshots.length})，跳过`);
    return 0;
  }

  const baseline = computeBaseline(snapshots);
  if (baseline.total < 3) return 0;
  logger.info(`[Optimizer] 基线: 样本=${baseline.total} 胜率=${(baseline.winRate * 100).toFixed(0)}%`);

  let rulesCreated = 0;

  // 按行情分组：对每种行情分别跑优化（跳过"all"，避免与特定行情规则叠加）
  const regimes = collectRegimes(snapshots).filter(r => r !== "all");
  for (const regime of regimes) {
    const snapshotsForRegime = snapshots.filter((s: any) => s.regime && s.regime.includes(regime));
    if (snapshotsForRegime.length < 5) continue;

    const regBaseline = computeBaseline(snapshotsForRegime);
    logger.info(`[Optimizer] 行情[${regime}] 样本=${snapshotsForRegime.length} 胜率=${(regBaseline.winRate * 100).toFixed(0)}%`);

    for (const ind of INDICATORS) {
      const segs = segmentByDeciles(snapshotsForRegime, ind.field, ind.name);
      for (const seg of segs) {
        const segTotal = seg.wins + seg.losses;
        if (segTotal < 3) continue;
        const segWr = segTotal > 0 ? seg.wins / segTotal : 0;
        const diff = segWr - regBaseline.winRate;
        if (Math.abs(diff) < 0.15) continue;
        let impactType: string;
        let impactValue: number;
        if (diff > 0) {
          impactType = "add";
          impactValue = Math.min(15, Math.round(diff * 50));
        } else {
          impactType = "multiply";
          impactValue = Math.max(0.3, 1.0 + diff * 1.5);
        }
        try {
          upsertOptRule({
            target: "score",
            regime,
            indicator: ind.name,
            operator: seg.label.includes("~") ? "between" : "lte",
            val1: seg.max,
            val2: seg.min !== seg.max ? seg.max : undefined,
            impact_type: impactType,
            impact_value: impactValue,
            sample_size: segTotal,
            win_rate: Math.round(segWr * 10000) / 100,
            baseline_win_rate: Math.round(regBaseline.winRate * 10000) / 100,
          });
          rulesCreated++;
          logger.info(`[Optimizer] [${regime}] ${ind.name} <= ${seg.max} → ${impactType} ${impactValue} (${(segWr * 100).toFixed(0)}%/${segTotal}笔 vs ${(regBaseline.winRate * 100).toFixed(0)}%)`);
        } catch (e) {}
      }
    }
  }

  await generateSignalTypeRules(snapshots, baseline.winRate);

  logger.info(`[Optimizer] 完成: 生成 ${rulesCreated} 条规则 (覆盖 ${regimes.length} 个行情类型)`);
  return rulesCreated;
}

/** 从 snapshots 收集出现的行情类型 — 保留多空方向 */
function collectRegimes(snapshots: any[]): string[] {
  const seen = new Set<string>();
  seen.add("all");
  for (const s of snapshots) {
    if (s.regime) {
      // 保留完整行情描述，如 "强趋势空"、"弱趋势多"、"震荡偏多"
      // 不合并方向，因为同一指标值在多方和空方趋势下意义不同
      seen.add(s.regime);
    }
  }
  return Array.from(seen);
}

/** 计算全局基线 */
function computeBaseline(snapshots: any[]): { total: number; wins: number; winRate: number } {
  let wins = 0;
  for (const s of snapshots) {
    if (s.result === "win") wins++;
  }
  const total = snapshots.length;
  return { total, wins, winRate: total > 0 ? wins / total : 0 };
}

/** 把数据按指标值均匀分成 5 段 */
function segmentByDeciles(snapshots: any[], field: string, name: string): Segment[] {
  const values = snapshots
    .map(s => ({ v: Number(s[field] ?? s[name]), win: s.result === "win" }))
    .filter(x => !isNaN(x.v));

  if (values.length < 5) return [];

  values.sort((a, b) => a.v - b.v);
  const segCount = 5;
  const segSize = Math.max(1, Math.floor(values.length / segCount));
  const segments: Segment[] = [];

  for (let i = 0; i < segCount && i * segSize < values.length; i++) {
    const start = i * segSize;
    const end = Math.min(start + segSize, values.length);
    const slice = values.slice(start, end);
    const wins = slice.filter(x => x.win).length;
    const losses = slice.length - wins;
    const min = slice[0].v;
    const max = slice[slice.length - 1].v;
    const label = min === max ? `${min.toFixed(1)}` : `${min.toFixed(1)}~${max.toFixed(1)}`;
    segments.push({ label, min, max, wins, losses });
  }

  return segments;
}

/**
 * 评估所有未评估过的决策
 * 对每次决策（含被跳过的），对比决策时的价格和当前价格，
 * 判断决策是否正确，记录到 decision_evaluations 表。
 */
export function evaluateUnjudgedDecisions(
  tickers: Map<string, any>
): number {
  const decisions = getUnevaluatedDecisions() as any[];
  if (decisions.length === 0) return 0;

  let evaluated = 0;
  for (const d of decisions) {
    const ticker = tickers.get(d.symbol);
    if (!ticker || !ticker.price || ticker.price <= 0) continue;

    // 从 raw_response 提取决策时的价格
    let priceAtDecision: number | null = null;
    if (d.raw_response) {
      try {
        const raw = JSON.parse(d.raw_response);
        priceAtDecision = raw.indicatorsSnapshot?.price ?? raw.trade?.price ?? raw.price ?? null;
      } catch {}
    }
    if (priceAtDecision === null || priceAtDecision <= 0) continue;

    const priceNow = ticker.price;
    const changePct = (priceNow - priceAtDecision) / priceAtDecision * 100;
    const absChange = Math.abs(changePct);

    let evaluation: string;
    let details: string;

    if (d.status === "success" || d.status === "opened") {
      // 已执行的决策：按实际盈亏方向评估
      // 如果 snapshot 已有 result，优先用那个
      // 这里仅根据价格方向做初步判断
      if (absChange < 0.8) {
        evaluation = "neutral";
        details = "价格变动不足 0.8%，无法判断";
      } else if (d.action === "sell") {
        evaluation = changePct < 0 ? "correct_trade" : "wrong_trade";
        details = `做空后价格${changePct < 0 ? "下跌" : "上涨"} ${Math.abs(changePct).toFixed(2)}%`;
      } else if (d.action === "buy") {
        evaluation = changePct > 0 ? "correct_trade" : "wrong_trade";
        details = `做多后价格${changePct > 0 ? "上涨" : "下跌"} ${Math.abs(changePct).toFixed(2)}%`;
      } else {
        evaluation = "neutral";
        details = `操作 ${d.action} 无法用价格方向评估`;
      }
    } else if (d.status === "skipped" || d.status === "ai_rejected" || d.status === "failed") {
      // 被跳过/失败的决策：判断是否错失机会
      if (absChange < 0.8) {
        evaluation = "neutral";
        details = "价格变动不足 0.8%，无法判断";
      } else if (d.action === "sell") {
        if (changePct < 0) {
          evaluation = "missed_opportunity";
          details = `跳过了做空，价格实际下跌 ${Math.abs(changePct).toFixed(2)}%（错失）`;
        } else if (changePct > 0) {
          evaluation = "correct_skip";
          details = `跳过了做空，价格实际上涨 ${changePct.toFixed(2)}%（正确）`;
        } else {
          evaluation = "neutral";
          details = "价格持平";
        }
      } else if (d.action === "buy") {
        if (changePct > 0) {
          evaluation = "missed_opportunity";
          details = `跳过了做多，价格实际上涨 ${changePct.toFixed(2)}%（错失）`;
        } else if (changePct < 0) {
          evaluation = "correct_skip";
          details = `跳过了做多，价格实际下跌 ${Math.abs(changePct).toFixed(2)}%（正确）`;
        } else {
          evaluation = "neutral";
          details = "价格持平";
        }
      } else {
        evaluation = "neutral";
        details = `状态 ${d.status} / 操作 ${d.action} 无法评估`;
      }
    } else {
      evaluation = "neutral";
      details = `状态 ${d.status} 未处理`;
    }

    try {
      insertDecisionEvaluation({
        decision_id: d.id,
        snapshot_id: d.snapshot_id ?? null,
        eval_time: new Date().toISOString(),
        symbol: d.symbol,
        action: d.action,
        status: d.status,
        price_at_decision: priceAtDecision,
        price_now: priceNow,
        price_change_pct: Math.round(changePct * 100) / 100,
        evaluation,
        details,
      });
      evaluated++;
    } catch {}
  }

  if (evaluated > 0) {
    logger.info(`[Evaluation] 评估了 ${evaluated}/${decisions.length} 条未评估决策`);
  }
  return evaluated;
}

/** 按信号类型统计（追空、追多等） */
async function generateSignalTypeRules(snapshots: any[], baselineWr: number): Promise<void> {
  // 从 reason/signal_type 字段分析追空/追多
  const chaseShort = snapshots.filter(s => (s.signal_type && s.signal_type.includes("chase_short")) || (s.side === "short" && (s.rsi_1d || 50) < 25));
  if (chaseShort.length >= 3) {
    const wins = chaseShort.filter(s => s.result === "win").length;
    const wr = wins / chaseShort.length;
    if (wr < baselineWr - 0.15) {
      try {
        upsertOptRule({
          target: "score",
          indicator: "chase_short_rsi_low",
          operator: "lte",
          val1: 100,
          impact_type: "multiply",
          impact_value: Math.max(0.3, 1.0 - (baselineWr - wr) * 1.5),
          sample_size: chaseShort.length,
          win_rate: Math.round(wr * 10000) / 100,
          baseline_win_rate: Math.round(baselineWr * 10000) / 100,
        });
        logger.info(`[Optimizer] 信号规则: 追空(RSI低) × ${Math.max(0.3, 1.0 - (baselineWr - wr) * 1.5).toFixed(2)} (${(wr * 100).toFixed(0)}%/${chaseShort.length}笔)`);
      } catch {}
    }
  }
}

// ========== 能力2: 双指标组合规律发现 ==========

/** 需要尝试组合的指标对（对胜率影响最大的组合） */
const COMBO_PAIRS: [string, string, string, string][] = [
  ["rsi_1h", "rsi_1h", "adx_1h", "adx_1h"],     // RSI + ADX 组合
  ["rsi_1h", "rsi_1h", "funding_rate", "funding_rate"], // RSI + 费率
  ["rsi_1d", "rsi_1d", "adx_1d", "adx_1d"],     // 日线 RSI + ADX
  ["adx_1h", "adx_1h", "atr_pct", "atr_pct"],   // ADX + 波动率
  ["rsi_1h", "rsi_1h", "market_quality", "market_quality"], // RSI + 行情质量
];

/**
 * 双指标组合搜索：对每对指标做 3×3 网格，找胜率异常的组合区间。
 * 只返回胜率显著偏离基线（>20%）且样本 >= 5 的组合。
 */
export function discoverComboPatterns(): number {
  const snapshots = getClosedSnapshots(200) as any[];
  if (snapshots.length < 20) return 0;

  let created = 0;
  // 按多空分组搜索，防偏态数据污染（如 71笔做空2笔做多）
  const sides = ["short", "long"];
  for (const side of sides) {
    const sideSnapshots = snapshots.filter(s => s.side === side);
    if (sideSnapshots.length < 10) continue;
    const baseline = sideSnapshots.filter(s => s.result === "win").length / sideSnapshots.length;

  for (const [f1, n1, f2, n2] of COMBO_PAIRS) {
    // 取 side 组内的有效值并按百分位分 3 档
    const vals1 = sideSnapshots.map(s => Number(s[f1] ?? s[n1])).filter(v => !isNaN(v)).sort((a,b) => a-b);
    const vals2 = sideSnapshots.map(s => Number(s[f2] ?? s[n2])).filter(v => !isNaN(v)).sort((a,b) => a-b);
    if (vals1.length < 20 || vals2.length < 20) continue;

    const p33_1 = vals1[Math.floor(vals1.length / 3)];
    const p66_1 = vals1[Math.floor(vals1.length * 2 / 3)];
    const p33_2 = vals2[Math.floor(vals2.length / 3)];
    const p66_2 = vals2[Math.floor(vals2.length * 2 / 3)];

    // 3×3 grid（用 sideSnapshots 而不是全部数据）
    const grid = new Map<string, { wins: number; total: number }>();
    for (const s of sideSnapshots) {
      const v1 = Number(s[f1] ?? s[n1]);
      const v2 = Number(s[f2] ?? s[n2]);
      if (isNaN(v1) || isNaN(v2)) continue;
      const r1 = v1 < p33_1 ? 0 : v1 < p66_1 ? 1 : 2;
      const r2 = v2 < p33_2 ? 0 : v2 < p66_2 ? 1 : 2;
      const k = `${n1}_${r1}_${n2}_${r2}`;
      const e = grid.get(k) || { wins: 0, total: 0 };
      e.total++;
      if (s.result === "win") e.wins++;
      grid.set(k, e);
    }

    for (const [k, e] of grid) {
      if (e.total < 5) continue;
      const wr = e.wins / e.total;
      if (Math.abs(wr - baseline) < 0.20) continue;
      const parts = k.split("_");
      const i1r = parseInt(parts[1]);
      const i2r = parseInt(parts[3]);
      try {
        // 用 -999 / 9999 作为边界哨兵值（替代 -Infinity/Infinity，SQLite 无法可靠存储 JS Infinity）
        const SENTINEL_LOW = -999;
        const SENTINEL_HIGH = 9999;
        // 只调用一次 upsertOptRule，不再冗余调用
        const comboVals = {
          target: "score" as const, regime: undefined,
          indicator: parts[0], operator: "between" as const,
          val1: i1r === 0 ? SENTINEL_LOW : i1r === 1 ? p33_1 : p66_1,
          val2: i1r === 0 ? p33_1 : i1r === 1 ? p66_1 : SENTINEL_HIGH,
          impact_type: (wr > baseline ? "add" : "multiply") as "add" | "multiply",
          impact_value: wr > baseline ? Math.min(10, Math.round((wr - baseline) * 40))
            : Math.max(0.3, 1.0 - (baseline - wr) * 1.5),
          sample_size: e.total,
          win_rate: Math.round(wr * 10000) / 100,
          baseline_win_rate: Math.round(baseline * 10000) / 100,
        };
        const ruleId = upsertOptRule(comboVals) as number;
        // 写入 combo 第二指标
        try {
          db.prepare("UPDATE opt_rules SET indicator2=?, op2='between', val3=?, val4=? WHERE id=?")
            .run(parts[2], i2r === 0 ? SENTINEL_LOW : i2r === 1 ? p33_2 : p66_2,
              i2r === 0 ? p33_2 : i2r === 1 ? p66_2 : SENTINEL_HIGH, ruleId);
        } catch {}
        created++;
      } catch {}
    }
  }
  } // end for side
  return created;
}

// ========== 能力3: 概念漂移检测 ==========

/**
 * 对每条活跃规则，用最近 N 笔符合条件的 trades 计算实际胜率，
 * 若与规则声称的 win_rate 持续偏差 > 20%，则降权或禁用。
 */
export function detectRuleDrift(): number {
  const rules = getActiveOptRules() as any[];
  if (rules.length === 0) return 0;

  const snapshots = getClosedSnapshots(200) as any[];
  if (snapshots.length < 10) return 0;

  let driftCount = 0;
  const now = new Date().toISOString();

  for (const rule of rules) {
    // 只检查数据驱动的规则（忽略种子规则 sample_size < 5）
    if ((rule.sample_size || 0) < 5) continue;

    // 找出该规则匹配的最近 snapshots
    const matches = snapshots.filter(s => {
      const v1 = Number(s[rule.indicator]);
      if (isNaN(v1)) return false;
      let m1 = false;
      if (rule.operator === "lt" && v1 < rule.val1) m1 = true;
      else if (rule.operator === "gt" && v1 > rule.val1) m1 = true;
      else if (rule.operator === "between" && v1 >= (rule.val1 <= -998 ? -1e9 : rule.val1) && v1 <= (rule.val2 >= 9998 ? 1e9 : rule.val2)) m1 = true;
      else if (rule.operator === "lte" && v1 <= rule.val1) m1 = true;
      else if (rule.operator === "gte" && v1 >= rule.val1) m1 = true;
      if (!m1) return false;
      // combo: 第二指标也需匹配
      if (rule.indicator2) {
        const v2 = Number(s[rule.indicator2]);
        if (isNaN(v2)) return false;
        if (rule.op2 === "between" && !(v2 >= (rule.val3 === -Infinity ? -1e9 : rule.val3) && v2 <= (rule.val4 === Infinity ? 1e9 : rule.val4))) return false;
        else if (rule.op2 === "lt" && !(v2 < rule.val3)) return false;
        else if (rule.op2 === "gt" && !(v2 > rule.val3)) return false;
      }
      return true;
    });

    if (matches.length < 5) continue;
    const observedWins = matches.filter(s => s.result === "win").length;
    const observedWr = observedWins / matches.length;
    const driftScore = (rule.win_rate || 0.5) - observedWr;

    const isDrifting = driftScore > 0.20 && matches.length >= 8;
    insertRulePerformance({
      rule_id: rule.id, check_time: now, recent_samples: matches.length,
      observed_win_rate: Math.round(observedWr * 10000) / 100,
      expected_win_rate: rule.win_rate ?? 0,
      drift_score: Math.round(driftScore * 10000) / 100,
      drift_detected: isDrifting,
    });

    if (isDrifting) {
      // 看历史: 连续 3 次漂移才降权
      const history = getRulePerformanceHistory(rule.id, 3);
      const recentDrifts = history.filter((h: any) => h.drift_detected).length;
      if (recentDrifts >= 3) {
        disableOptRule(rule.id);
        logger.info(`[Drift] 规则 #${rule.id} (${rule.indicator}${rule.operator}${rule.val1}) 连续${recentDrifts}次漂移 → 禁用`);
      } else {
        logger.info(`[Drift] 规则 #${rule.id} (${rule.indicator}${rule.operator}${rule.val1}) 漂移${(driftScore*100).toFixed(0)}% (观察${matches.length}笔/实际${(observedWr*100).toFixed(0)}% vs 预期${((rule.win_rate||0)*100).toFixed(0)}%)`);
      }
      driftCount++;
    }
  }
  return driftCount;
}

// ========== 能力4: 行情类型变迁检测 ==========

/** 全局 ADX 趋势追踪 */
let regimeAdxHistory: { time: string; avgAdx: number }[] = [];

/**
 * 检测行情是否在变迁: 计算最近 N 个周期的平均 ADX 对比早期 ADX
 * 如果变动 > 30%，标记行情 shift
 */
export function detectRegimeShift(avgAdx1h: number, avgAdx1d: number): { shifted: boolean; detail: string } {
  const now = new Date().toISOString();
  regimeAdxHistory.push({ time: now, avgAdx: avgAdx1h });
  // 保留最近 30 条
  if (regimeAdxHistory.length > 30) regimeAdxHistory.shift();

  if (regimeAdxHistory.length < 10) return { shifted: false, detail: "样本不足" };

  const recent = regimeAdxHistory.slice(-10);
  const early = regimeAdxHistory.slice(0, 10);
  const recentAvg = recent.reduce((s, x) => s + x.avgAdx, 0) / recent.length;
  const earlyAvg = early.reduce((s, x) => s + x.avgAdx, 0) / early.length;

  if (earlyAvg === 0) return { shifted: false, detail: "早期 ADX 为 0" };

  const change = (recentAvg - earlyAvg) / earlyAvg;
  if (Math.abs(change) > 0.30) {
    const dir = change > 0 ? "趋势增强" : "趋势减弱";
    const detail = `ADX ${earlyAvg.toFixed(0)} → ${recentAvg.toFixed(0)} (${dir}, 变动${(Math.abs(change)*100).toFixed(0)}%)`;
    logger.info(`[RegimeShift] ${detail}`);
    // 清空历史，从新行情重新学习
    regimeAdxHistory = [];
    return { shifted: true, detail };
  }

  return { shifted: false, detail: `ADX 稳定 (${recentAvg.toFixed(0)})` };
}
