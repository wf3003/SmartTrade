/**
 * 行情分级参数默认值
 * 
 * 每种行情有自己独立的参数起点。
 * AI 复盘可以在各行情内继续动态调整，调整结果通过 regime_params 快照持久化。
 * 
 * 七种行情:
 *   强趋势多 / 强趋势空 / 弱趋势多 / 弱趋势空 / 震荡偏多 / 震荡偏空 / 纯震荡 / unknown
 */

type RegimeDefaults = Record<string, number>;

/** 强趋势行情 (ADX>40): 趋势明确，敢于上杠杆，止损放宽 */
const STRONG_TREND: RegimeDefaults = {
  ai_score_min: 35,
  entry_quality_min: 25,
  market_quality_min: 15,
  aggressiveness: 65,
  sl_atr_mult: 400,
  tp_atr_mult: 500,
  trail_pnl_atr_mult: 280,
  profit_protect_retrace_pct: 55,
  profit_protect_min_line: 2.0,
  max_stop_loss_pct: 700,
  max_total_margin_pct: 60,
  pos_mq_mult_med: 70,
  lev_vol_mult_high: 80,
  lev_vol_mult_mid: 110,
  lev_vol_mult_low: 150,
  min_risk_reward_ratio: 150,
};

/** 弱趋势行情 (ADX 25-40) */
const WEAK_TREND: RegimeDefaults = {
  ai_score_min: 40,
  entry_quality_min: 30,
  market_quality_min: 18,
  aggressiveness: 50,
  sl_atr_mult: 350,
  tp_atr_mult: 400,
  trail_pnl_atr_mult: 250,
  profit_protect_retrace_pct: 50,
  profit_protect_min_line: 1.5,
  max_stop_loss_pct: 600,
  max_total_margin_pct: 50,
  pos_mq_mult_med: 60,
  lev_vol_mult_high: 70,
  lev_vol_mult_mid: 100,
  lev_vol_mult_low: 140,
  min_risk_reward_ratio: 150,
};

/** 震荡偏多/偏空 (ADX 18-25): 方向不明，保守为主 */
const OSCILLATING_BIAS: RegimeDefaults = {
  ai_score_min: 45,
  entry_quality_min: 35,
  market_quality_min: 20,
  aggressiveness: 40,
  sl_atr_mult: 280,
  tp_atr_mult: 320,
  trail_pnl_atr_mult: 220,
  profit_protect_retrace_pct: 40,
  profit_protect_min_line: 1.2,
  max_stop_loss_pct: 500,
  max_total_margin_pct: 40,
  pos_mq_mult_med: 50,
  lev_vol_mult_high: 60,
  lev_vol_mult_mid: 85,
  lev_vol_mult_low: 120,
  min_risk_reward_ratio: 180,
  eq_rsi_mild_os_sp: 10,
  eq_rsi_mild_ob_sb: 7,
  eq_momentum_decay_p: 15,
};

/** 纯震荡 (ADX<18): 无趋势，最保守 */
const PURE_OSCILLATION: RegimeDefaults = {
  ai_score_min: 50,
  entry_quality_min: 40,
  market_quality_min: 25,
  aggressiveness: 30,
  sl_atr_mult: 220,
  tp_atr_mult: 250,
  trail_pnl_atr_mult: 180,
  profit_protect_retrace_pct: 30,
  profit_protect_min_line: 0.8,
  max_stop_loss_pct: 400,
  max_total_margin_pct: 30,
  pos_mq_mult_high: 80,
  pos_mq_mult_med: 40,
  pos_mq_mult_low: 25,
  lev_vol_mult_high: 50,
  lev_vol_mult_mid: 70,
  lev_vol_mult_low: 100,
  min_risk_reward_ratio: 200,
  eq_rsi_mild_os_sp: 12,
  eq_rsi_mild_ob_sb: 8,
  eq_momentum_decay_p: 18,
  eq_bb_mild_ob_lp: 8,
  eq_bb_mild_os_sp: 8,
};

/** unknown / 初始状态：中性参数 */
const UNKNOWN: RegimeDefaults = {
  ai_score_min: 40,
  entry_quality_min: 30,
  market_quality_min: 20,
  aggressiveness: 50,
  sl_atr_mult: 400,
  tp_atr_mult: 400,
  trail_pnl_atr_mult: 250,
  profit_protect_retrace_pct: 50,
  profit_protect_min_line: 1.5,
  max_stop_loss_pct: 600,
  max_total_margin_pct: 50,
  pos_mq_mult_med: 60,
  lev_vol_mult_high: 70,
  lev_vol_mult_mid: 100,
  lev_vol_mult_low: 150,
  min_risk_reward_ratio: 150,
};

export function getRegimeDefaults(regime: string): Map<string, number> {
  let defaults: RegimeDefaults;

  if (regime.includes("强趋势")) {
    defaults = STRONG_TREND;
  } else if (regime.includes("弱趋势")) {
    defaults = WEAK_TREND;
  } else if (regime.includes("震荡偏")) {
    defaults = OSCILLATING_BIAS;
  } else if (regime.includes("纯震荡")) {
    defaults = PURE_OSCILLATION;
  } else {
    defaults = UNKNOWN;
  }

  return new Map(Object.entries(defaults));
}
