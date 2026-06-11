/**
 * #5 AI评分偏移监测 — 检测AI评分系统性偏差并自动修正
 *
 * 问题: AI在强空趋势中做多评分虚高(BTC long 4次全亏-$73)，
 *       在超卖环境中做空评分偏高(LINK RSI26做空给43分)。
 * 方案: 记录每笔交易的AI评分vs实际结果，检测方向性偏差，
 *       自动调整符号评分基准。
 */

import { db } from "./db";
import { logger } from "./logger";

/**
 * 记录一笔交易的实际结果
 */
export function recordScoreDrift(symbol: string, side: "long" | "short", aiScore: number, pnl: number) {
  try {
    db.prepare(
      `INSERT INTO score_drift_log (symbol, side, ai_score, pnl, result, time)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(symbol, side, aiScore, pnl, pnl >= 0 ? "win" : "loss");
  } catch {}
}

/**
 * 分析最近N笔交易的评分偏差
 */
export function analyzeScoreDrift(lookbackTrades: number = 30): {
  longOffset: number;
  shortOffset: number;
  details: string;
} {
  try {
    const rows = db.prepare(
      `SELECT side, ai_score, result FROM score_drift_log ORDER BY id DESC LIMIT ?`
    ).all(lookbackTrades) as any[];

    if (rows.length < 5) return { longOffset: 0, shortOffset: 0, details: "样本不足" };

    interface DirData { wins: number; total: number; avgWinningScore: number; avgLosingScore: number; winScores: number[]; loseScores: number[]; }
    const byDir: Record<string, DirData> = {
      long: { wins: 0, total: 0, avgWinningScore: 0, avgLosingScore: 0, winScores: [], loseScores: [] },
      short: { wins: 0, total: 0, avgWinningScore: 0, avgLosingScore: 0, winScores: [], loseScores: [] },
    };

    for (const r of rows) {
      const d = r.side === "long" ? "long" : "short";
      byDir[d].total++;
      if (r.result === "win") { byDir[d].wins++; byDir[d].winScores.push(r.ai_score); }
      else { byDir[d].loseScores.push(r.ai_score); }
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a: number, b: number) => a + b, 0) / arr.length : 0;
    for (const d of ["long", "short"]) { byDir[d].avgWinningScore = avg(byDir[d].winScores); byDir[d].avgLosingScore = avg(byDir[d].loseScores); }

    let longOffset = 0, shortOffset = 0;
    const details: string[] = [];

    for (const d of ["long", "short"]) {
      const data = byDir[d];
      if (data.total < 3) continue;
      const winRate = data.wins / data.total;
      const scoreDiff = data.avgLosingScore - data.avgWinningScore;

      if (scoreDiff > 10 && data.loseScores.length >= 2) {
        const offset = -Math.round(scoreDiff * 0.5);
        if (d === "long") longOffset = offset; else shortOffset = offset;
        details.push(`${d}评分虚高: 盈利均分${data.avgWinningScore.toFixed(0)} vs 亏损均分${data.avgLosingScore.toFixed(0)} → 下调${Math.abs(offset)}分`);
      }
      if (winRate < 0.3 && data.total >= 5) {
        const offset = -Math.round((0.5 - winRate) * 40);
        if (d === "long") longOffset += offset; else shortOffset += offset;
        details.push(`${d}胜率${(winRate * 100).toFixed(0)}%过低 → 额外下调${Math.abs(offset)}分`);
      }
    }

    if (longOffset !== 0 || shortOffset !== 0) {
      logger.warn(`[ScoreDrift] ${details.join(" | ")}`);
    }
    return { longOffset: Math.max(-40, longOffset), shortOffset: Math.max(-40, shortOffset), details: details.join(" | ") || "正常" };
  } catch (e: any) {
    return { longOffset: 0, shortOffset: 0, details: `分析失败: ${e.message}` };
  }
}

/** 确保表存在 */
export function ensureScoreDriftTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS score_drift_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      ai_score INTEGER NOT NULL,
      pnl REAL NOT NULL,
      result TEXT NOT NULL,
      time TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_drift_side_result ON score_drift_log(side, result)`);
}
