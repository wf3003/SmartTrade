/**
 * 策略3: 风控/风险回报评估
 * 输入: 账户状态, 持仓列表, 波动率(ATR), 技术面方向
 * 输出: 单个币种的风险评分 + 最优仓位 + 止损/止盈建议
 */
import type { Position, AccountInfo } from "../exchanges";
import type { TechnicalAnalysis } from "./technical";
import type { SentimentAnalysis } from "./sentiment";
import { CONFIG } from "../config";

export interface RiskAssessment {
  symbol: string;
  /** 风险偏好: low=轻仓, medium=半仓, high=满仓, avoid=不进 */
  riskAppetite: "low" | "medium" | "high" | "avoid";
  /** 建议杠杆 */
  suggestedLeverage: number;
  /** 建议仓位比例(%) */
  suggestedAmountPct: number;
  /** 建议止损% */
  suggestedStopLossPct: number;
  /** 建议止盈% */
  suggestedTakeProfitPct: number;
  /** 综合风险分数 0-100 (越高越值得交易) */
  riskScore: number;
  /** AI prompt 分析文本 */
  analysis: string;
  /** 风险警告 */
  warnings: string[];
}

export interface PortfolioRisk {
  /** 当前总敞口% */
  totalExposurePct: number;
  /** 是否已达持仓上限 */
  atPositionLimit: boolean;
  /** 账户风险等级 */
  riskLevel: "safe" | "moderate" | "high" | "critical";
  /** 可用保证金 */
  availableMargin: number;
  analysis: string;
}

/**
 * 币种级别风控评估
 */
export function assessSymbolRisk(
  symbol: string,
  tech: TechnicalAnalysis,
  sent: SentimentAnalysis,
  atrPct: number,
  existingPosition: Position | undefined,
): RiskAssessment {
  const warnings: string[] = [];
  let riskScore = 50;

  // 1. 技术面方向明确度
  if (tech.directionBias !== "neutral") {
    riskScore += tech.confidence * 0.2;
    if (tech.alignmentScore >= 80) riskScore += 10;
    else if (tech.alignmentScore >= 60) riskScore += 5;
    else warnings.push("多周期分歧,方向不可靠");
  } else {
    riskScore -= 15;
    warnings.push("技术面方向中性,缺乏交易依据");
  }

  // 2. 资金面/情绪面
  if (sent.sentimentBias !== "neutral") {
    // 技术面与资金面同向 → 加分
    if (tech.directionBias === sent.sentimentBias) {
      riskScore += sent.confidence * 0.15;
    } else if (tech.directionBias !== "neutral") {
      // 技术面与资金面反向 → 扣分
      riskScore -= 10;
      warnings.push("技术面与资金面矛盾");
    }
  }

  // 3. 行情质量
  if (sent.marketQuality >= 60) riskScore += 8;
  else if (sent.marketQuality >= 40) riskScore += 2;
  else {
    riskScore -= 15;
    warnings.push(`行情质量低(mq${sent.marketQuality})`);
  }

  // 4. ATR 波动率 → 影响杠杆和仓位
  let suggestedLeverage = CONFIG.defaultLeverage;
  let suggestedAmountPct = CONFIG.basePositionPct;
  let suggestedSlPct = Math.max(2, Math.min(8, atrPct * 2));
  let suggestedTpPct = suggestedSlPct * 2.5;

  if (atrPct > 5) {
    // 高波动 → 降杠杆升仓位
    suggestedLeverage = Math.max(2, CONFIG.defaultLeverage - 2);
    suggestedAmountPct = Math.round(CONFIG.basePositionPct * 0.6);
    suggestedSlPct = Math.min(8, atrPct * 1.5);
    suggestedTpPct = suggestedSlPct * 2;
    riskScore -= 5;
    warnings.push(`高波动(ATR${atrPct.toFixed(1)}%),降杠杆至${suggestedLeverage}x`);
  } else if (atrPct < 1.5) {
    // 低波动 → 加杠杆但降仓位(波动小盈利空间也小)
    suggestedLeverage = Math.min(CONFIG.maxLeverage, CONFIG.defaultLeverage + 2);
    suggestedAmountPct = Math.round(CONFIG.basePositionPct * 0.7);
    riskScore -= 3;
    warnings.push(`低波动(ATR${atrPct.toFixed(1)}%),盈利空间有限`);
  }

  // 5. 已有持仓 → 同币种不建议加仓（但可以继续持有）
  if (existingPosition) {
    riskScore -= 10;
    warnings.push("已有同币种持仓(不影响持有,但不建议加仓)");
  }

  // 6. 风险分数 → 风险偏好
  let riskAppetite: "low" | "medium" | "high" | "avoid";
  if (riskScore >= 70) {
    riskAppetite = "high";
  } else if (riskScore >= 50) {
    riskAppetite = "medium";
  } else if (riskScore >= 30) {
    riskAppetite = "low";
  } else {
    riskAppetite = "avoid";
  }

  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));

  // 风险偏好 → 仓位/杠杆修正
  if (riskAppetite === "high") {
    // 不做额外修正,使用基础值
  } else if (riskAppetite === "medium") {
    suggestedAmountPct = Math.round(suggestedAmountPct * 0.65);
  } else if (riskAppetite === "low") {
    suggestedAmountPct = Math.round(suggestedAmountPct * 0.3);
    suggestedLeverage = Math.max(2, suggestedLeverage - 2);
  }

  const analysis = [
    `【风控】${symbol} 风险分:${riskScore} 偏好:${riskAppetite} 建议杠杆:${suggestedLeverage}x 仓位:${suggestedAmountPct}% 止损:${suggestedSlPct.toFixed(1)}% 止盈:${suggestedTpPct.toFixed(1)}%`,
    warnings.length ? `风险: ${warnings.join(" | ")}` : "",
  ].filter(Boolean).join("\n");

  return {
    symbol,
    riskAppetite,
    suggestedLeverage,
    suggestedAmountPct,
    suggestedStopLossPct: Math.round(suggestedSlPct * 10) / 10,
    suggestedTakeProfitPct: Math.round(suggestedTpPct * 10) / 10,
    riskScore,
    analysis,
    warnings,
  };
}

/**
 * 组合级别风控评估
 */
export function assessPortfolioRisk(
  account: AccountInfo,
  positions: Position[],
): PortfolioRisk {
  const totalEquity = account.totalEquity || 0;
  const marginUsed = account.marginUsed || 0;
  const availableBalance = account.availableBalance || 0;
  const totalExposurePct = totalEquity > 0 ? (marginUsed / totalEquity) * 100 : 0;
  const atPositionLimit = positions.length >= CONFIG.maxPositions;

  let riskLevel: "safe" | "moderate" | "high" | "critical";
  if (totalExposurePct < 15) riskLevel = "safe";
  else if (totalExposurePct < 30) riskLevel = "moderate";
  else if (totalExposurePct < 50) riskLevel = "high";
  else riskLevel = "critical";

  const analysis = [
    `【组合风控】敞口:${totalExposurePct.toFixed(1)}% 持仓:${positions.length}/${CONFIG.maxPositions} 风险:${riskLevel} 可用:$${availableBalance.toFixed(0)}`,
    totalExposurePct >= 50 ? "⚠ 总敞口过高,应平仓减仓" : "",
    atPositionLimit ? "⚠ 已达持仓上限,只能置换不能新增" : "",
    riskLevel === "critical" ? "⚠ 风险临界,强制不开新仓" : "",
  ].filter(Boolean).join("\n");

  return {
    totalExposurePct,
    atPositionLimit,
    riskLevel,
    availableMargin: availableBalance,
    analysis,
  };
}
