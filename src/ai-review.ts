/**
 * AI 交易复盘 — 定时分析历史交易，深度输出改进建议
 */
import { CONFIG } from "./config";
import { logger } from "./logger";
import { openai } from "./ai-client";
import { interceptParamsCache } from "./state";

export function buildDecisionAnalysis(decisions: any[]): string {
  if (!decisions || decisions.length === 0) return "";
  const recent = decisions.filter(d => d.raw_response).slice(-20);
  
  // Count decisions with structured snapshots for summary
  let withSnap = 0;
  const snapshots: any[] = [];
  
  const lines = recent.map((d: any) => {
    try {
      const raw = JSON.parse(d.raw_response);
      const aiScore = raw.aiScore ?? "?";
      const aiReason = (raw.aiReason || "").slice(0, 80);
      const snap = raw.indicatorsSnapshot;
      if (snap) {
        withSnap++;
        snapshots.push({ symbol: d.symbol, action: d.action, aiScore, rsi: snap.rsi, fundingRatePct: snap.fundingRatePct, status: d.status });
      }
      return `${d.symbol} ${d.action} | AI评分:${aiScore} | ${aiReason} | 状态:${d.status}`;
    } catch {
      return `${d.symbol} ${d.action} | ${(d.reason||"").slice(0, 80)} | 状态:${d.status}`;
    }
  });

  let snapSection = '';
  if (snapshots.length > 0) {
    snapSection = '\n【开仓时指标快照（结构化数据，供统计分析）】\n';
    snapSection += 'RSI  | 费率   | 操作 | AI评分\n';
    for (const s of snapshots) {
      snapSection += `RSI${s.rsi} | ${s.fundingRatePct}% | ${s.symbol} ${s.action} | 评分${s.aiScore}\n`;
    }
    snapSection += '\n请分析：哪些RSI/费率组合下AI评分偏高/偏低？哪个区间的决策最终盈利？\n';
  }

  return `【AI决策历史（最近${lines.length}条）】\n${lines.join("\n")}${snapSection}`;
}

export async function aiTradeReview(
  tradeSummary: string,
  symbolStats: string,
  strategyConfig: string,
  openPositions: string = "",
  backtestLog: string = "",
  decisionAnalysis: string = "",
): Promise<string> {
  if (!tradeSummary) return "";

  const posSection = openPositions ? `【当前持仓实时状态】
${openPositions}

` : "";

  const btSection = backtestLog ? `【近期回测趋势】
${backtestLog}

` : "";

  const decSection = decisionAnalysis ? `${decisionAnalysis}

 ` : "";

  // 从 DB 读取拦截参数的实际当前值（不复用默认值，防 AI 基于错误基线调参）
  const aiMin = interceptParamsCache.get("ai_score_min") ?? 45;
  const eqMin = interceptParamsCache.get("entry_quality_min") ?? 35;
  const mqMin = interceptParamsCache.get("market_quality_min") ?? 20;
  const agg = interceptParamsCache.get("aggressiveness") ?? 50;
  const momDecay = interceptParamsCache.get("eq_momentum_decay_p") ?? 12;
  const mildOsSp = interceptParamsCache.get("eq_rsi_mild_os_sp") ?? 8;
  const mildObSb = interceptParamsCache.get("eq_rsi_mild_ob_sb") ?? 5;
  const paramVals = `entry_quality_min(当前${eqMin}), ai_score_min(当前${aiMin}), market_quality_min(当前${mqMin}), aggressiveness(当前${agg}), momentum_decay_p(当前${momDecay}), eq_rsi_mild_os_sp(当前${mildOsSp}), eq_rsi_mild_ob_sb(当前${mildObSb})`;

  const prompt = `你是一个加密货币交易策略分析师。以下是系统的近期交易记录和策略配置。

${posSection}${btSection}${decSection}【策略配置】
${strategyConfig}

【逐笔交易明细】
${tradeSummary}

【按币种分组统计】
${symbolStats}

请以 JSON 格式输出分析：
{
  "summary": "一句话总结近期表现",
  "winners": [{"signal":"信号类型","reason":"为什么赚钱"}],
  "losers": [{"signal":"信号类型","reason":"为什么亏"}],
  "bySymbol": [{"symbol":"BTC/USDT","analysis":"表现分析"}],
  "suggestions": ["具体优化建议"],
  "blockSignals": "哪些信号需要降分？为什么？(只降分不禁止)",
  "blockSymbols": ["BCH/USDT", "SUI/USDT"],
  "scoringAdvice": "基于AI决策历史，哪些类型的市场环境AI评分偏高/偏低？应该怎么校准？",
   "adjustIntercepts": "必需! 基于近期被拦截的交易和盈亏结果，判断是否需要调整拦截参数。可调的拦截参数: ${paramVals}。检查已有交易和拦截记录，如果发现某个参数导致的拦截让错过太多盈利机会，就降低阈值；如果某个参数放行的交易频繁亏损，就提高阈值。格式: [{param:\"param_name\", value:新数值, reason:\"基于XX笔交易分析\"}] 至少输出1条建议，不得输出空数组"
}`;

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.ai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: CONFIG.ai.maxTokens,
      response_format: { type: "json_object" },
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    if (text === "{}" || text.length < 20) {
      logger.warn(`[复盘] AI 返回过短(${text.length}字): ${text.slice(0, 150)}`);
      return "";
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed.summary || parsed.winners || parsed.losers || parsed.suggestions) {
        return JSON.stringify(parsed, null, 2);
      }
      logger.warn(`[复盘] 缺关键字段: ${text.slice(0, 300)}`);
      return "";
    } catch {
      logger.warn(`[复盘] 非JSON(${text.length}字): ${text.slice(0, 200)}`);
      return "";
    }
  } catch (e: any) {
    logger.warn(`[复盘] 异常: ${e.message?.slice(0, 200)}`);
    return "";
  }
}

export function buildTradeSummary(trades: any[]): string {
  if (!trades || trades.length === 0) return "";
  // 取最近30笔，防提示词过长导致AI返回空JSON
  const recent = trades.slice(-30);
  return recent.map((t: any) => {
    const pnl = t.pnl || 0;
    const e = pnl >= 0 ? "✅" : "❌";
    const peak = t.peak_pnl_pct ? `峰值${t.peak_pnl_pct.toFixed(1)}%` : "";
    const reason = (t.reason||"").slice(0,80);
    return `${e} ${t.symbol} ${t.side} ${t.leverage}x | 盈亏:$${pnl.toFixed(2)} (${(t.pnl_pct||0).toFixed(1)}%) ${peak} | ${t.close_type||""} | ${reason}`;
  }).join("\n");
}

export function buildSymbolStats(trades: any[]): string {
  if (!trades) return "";
  const recent = trades.slice(-30);
  const map: Record<string, {pnl:number; w:number; l:number; ct:string[]}> = {};
  for (const t of recent) {
    if (t.status !== "closed") continue;
    const s = t.symbol;
    if (!map[s]) map[s] = {pnl:0, w:0, l:0, ct:[]};
    map[s].pnl += t.pnl||0;
    (t.pnl||0) >= 0 ? map[s].w++ : map[s].l++;
    if (t.close_type) map[s].ct.push(t.close_type);
  }
  return Object.entries(map).map(([sym, s]) => {
    const t = s.w+s.l, wr = t>0?(s.w/t*100).toFixed(0):"0";
    return `${sym}: ${s.w}胜${s.l}负(${wr}%) 净盈亏:$${s.pnl.toFixed(2)} | 出场:${[...new Set(s.ct)].join(",")}`;
  }).join("\n");
}
