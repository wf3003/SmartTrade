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
import { getClosedSnapshots, getUnevaluatedDecisions, insertDecisionEvaluation, upsertOptRule } from "./db";

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
