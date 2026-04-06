/**
 * Accuracy Assistant — Predictive Error Detection
 *
 * Analyzes historical correction patterns from IntakeReview data and
 * state-specific rules to assign a predictive risk score (0–100) to
 * each case BEFORE benefits are determined.
 *
 * High-risk cases (score >= HIGH_RISK_THRESHOLD) are flagged for
 * mandatory caseworker review. Low-risk cases flow through normally.
 *
 * Risk factors:
 *   1. Historical error patterns — correction rates by type/state
 *   2. State-specific rule complexity — states with BBCE, waivers, etc.
 *   3. Case characteristics — self-employment, large households, threshold proximity
 *   4. Consistency check severity — leverages existing flag analysis
 */

const prisma = require("../lib/prisma");
const { child } = require("./logger");
const log = child("accuracy-assistant");

// Scoring thresholds — cases at or above these scores get flagged
const HIGH_RISK_THRESHOLD = 70;
const MEDIUM_RISK_THRESHOLD = 40;

// How many days of historical data to analyze when refreshing patterns
const HISTORY_WINDOW_DAYS = 180;

// ─── Risk Factor Definitions ────────────────────────────────────────
// Each factor extracts a signal from the case data and returns a
// weighted contribution to the overall score.

const RISK_FACTORS = [
  {
    name: "self_employment_income",
    description: "Self-employment income is the #1 source of SNAP overpayment errors (USDA QC)",
    baseWeight: 15,
    evaluate(intake) {
      const selfEmp = (intake.incomeSources || []).filter(
        (s) => s.incomeType === "SELF_EMPLOYMENT"
      );
      if (selfEmp.length === 0) return { score: 0, detail: null };

      let maxScore = 10;
      const details = [];

      for (const source of selfEmp) {
        const gross = source.selfEmploymentGross || source.grossAmountPerPeriod || 0;
        const expenses = source.selfEmploymentExpenses || 0;

        if (gross > 0 && expenses > gross * 0.6) {
          maxScore = 15;
          details.push(`Business expenses ${Math.round((expenses / gross) * 100)}% of gross`);
        }
        if (source.selfEmploymentDeductionMethod === "ITEMIZED") {
          maxScore = Math.max(maxScore, 12);
          details.push("Itemized deduction method (harder to verify)");
        }
      }

      return {
        score: maxScore,
        detail: `Self-employment income detected: ${details.join("; ") || "standard risk"}`,
      };
    },
  },

  {
    name: "pay_frequency_risk",
    description: "Pay frequency misreporting accounts for ~8-10% of overpayment errors",
    baseWeight: 12,
    evaluate(intake) {
      const monthlyEmployment = (intake.incomeSources || []).filter(
        (s) =>
          s.payFrequency === "MONTHLY" &&
          s.incomeType === "EMPLOYMENT" &&
          s.grossAmountPerPeriod >= 400 &&
          s.grossAmountPerPeriod <= 1800
      );

      if (monthlyEmployment.length === 0) return { score: 0, detail: null };

      return {
        score: 12,
        detail: `${monthlyEmployment.length} income source(s) reported as monthly in common biweekly range ($400-$1800)`,
      };
    },
  },

  {
    name: "multiple_adults_no_income",
    description: "Multiple working-age adults with no income is the strongest predictor of unreported income",
    baseWeight: 18,
    evaluate(intake) {
      const members = intake.householdMembers || [];
      const incomeSources = intake.incomeSources || [];

      let noIncomeAdultCount = 0;
      for (const member of members) {
        if (!member.inSnapHousehold) continue;
        if (
          member.ageRange === "under 18" ||
          (member.ageRange && member.ageRange.startsWith("0-"))
        )
          continue;

        if (!member.hasEarnedIncome && !member.hasUnearnedIncome) {
          const linked = incomeSources.some((s) => s.householdMemberId === member.id);
          if (!linked) noIncomeAdultCount++;
        }
      }

      if (noIncomeAdultCount < 2) return { score: 0, detail: null };

      return {
        score: Math.min(18, 9 * noIncomeAdultCount),
        detail: `${noIncomeAdultCount} working-age adults report no income`,
      };
    },
  },

  {
    name: "zero_income_with_shelter",
    description: "$0 income with rent payments strongly indicates unreported income",
    baseWeight: 16,
    evaluate(intake, calculations) {
      const grossIncome = calculations?.deductions?.grossIncome ?? null;
      const shelter = intake.shelterExpense;

      if (grossIncome !== 0 || !shelter || (shelter.rentOrMortgage || 0) === 0) {
        return { score: 0, detail: null };
      }

      return {
        score: 16,
        detail: `$0 income but pays $${shelter.rentOrMortgage}/mo rent`,
      };
    },
  },

  {
    name: "threshold_proximity",
    description: "Income near eligibility thresholds has high error impact — small mistakes change outcomes",
    baseWeight: 10,
    evaluate(intake, calculations) {
      if (!calculations?.deductions) return { score: 0, detail: null };

      // Use the consistency flags as a proxy for threshold proximity.
      // The consistency checker already computes proximity to income limits.
      const flags = intake.consistencyFlags || [];
      const thresholdFlags = (Array.isArray(flags) ? flags : []).filter(
        (f) => f.type === "THRESHOLD_PROXIMITY"
      );

      if (thresholdFlags.length === 0) return { score: 0, detail: null };

      return {
        score: 10,
        detail: `Income within 5% of eligibility threshold (${thresholdFlags.length} threshold flag(s))`,
      };
    },
  },

  {
    name: "large_household",
    description: "Larger households have more income sources to verify and higher error rates",
    baseWeight: 8,
    evaluate(intake) {
      const memberCount = (intake.householdMembers || []).filter(
        (m) => m.inSnapHousehold
      ).length;

      // Count the applicant
      const householdSize = memberCount + 1;

      if (householdSize <= 3) return { score: 0, detail: null };

      const score = Math.min(8, (householdSize - 3) * 2);
      return {
        score,
        detail: `Household size ${householdSize} (${memberCount} members + applicant)`,
      };
    },
  },

  {
    name: "income_expense_mismatch",
    description: "Shelter costs exceeding 80% of gross income signals unreported income",
    baseWeight: 14,
    evaluate(intake, calculations) {
      const grossIncome = calculations?.deductions?.grossIncome;
      const shelter = intake.shelterExpense;

      if (!grossIncome || grossIncome <= 0 || !shelter) return { score: 0, detail: null };

      const totalShelter = shelter.totalShelterCost || 0;
      if (totalShelter <= grossIncome * 0.8) return { score: 0, detail: null };

      const ratio = Math.round((totalShelter / grossIncome) * 100);
      return {
        score: 14,
        detail: `Shelter costs are ${ratio}% of gross income`,
      };
    },
  },

  {
    name: "deduction_eligibility_concern",
    description: "Deductions claimed without eligible household members",
    baseWeight: 12,
    evaluate(intake) {
      const members = intake.householdMembers || [];
      const incomeSources = intake.incomeSources || [];
      const hasElderlyOrDisabled = members.some((m) => m.isElderly || m.isDisabled);
      const hasEarnedIncome = incomeSources.some(
        (s) => s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT"
      );

      let score = 0;
      const details = [];

      if (intake.dependentCareExpense > 0 && !hasEarnedIncome) {
        score += 8;
        details.push("Dependent care claimed but no earned income");
      }
      if (intake.medicalExpenses > 0 && !hasElderlyOrDisabled) {
        score += 8;
        details.push("Medical expenses claimed but no elderly/disabled member");
      }
      if (intake.medicalExpenses > 400) {
        score += 4;
        details.push(`High medical expenses: $${intake.medicalExpenses}/mo`);
      }

      return {
        score: Math.min(12, score),
        detail: details.length > 0 ? details.join("; ") : null,
      };
    },
  },

  {
    name: "consistency_flag_severity",
    description: "Severity of flags from the rule-based consistency checker",
    baseWeight: 10,
    evaluate(intake) {
      const flags = intake.consistencyFlags;
      if (!flags || !Array.isArray(flags)) return { score: 0, detail: null };

      const highCount = flags.filter((f) => f.severity === "HIGH").length;
      const mediumCount = flags.filter((f) => f.severity === "MEDIUM").length;

      const score = Math.min(10, highCount * 4 + mediumCount * 2);
      if (score === 0) return { score: 0, detail: null };

      return {
        score,
        detail: `${highCount} HIGH and ${mediumCount} MEDIUM consistency flags`,
      };
    },
  },
];

// ─── Historical Pattern Analysis ────────────────────────────────────

/**
 * Refresh cached error patterns by analyzing IntakeReview correction data.
 * Groups corrections by state + type and computes error rates for known
 * case characteristic patterns.
 *
 * Should be run periodically (nightly cron or admin-triggered).
 */
async function refreshErrorPatterns(stateCode) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - HISTORY_WINDOW_DAYS);

  // Fetch reviewed intakes with corrections for this state
  const reviewedIntakes = await prisma.intake.findMany({
    where: {
      county: { stateCode },
      status: { in: ["REVIEWED"] },
      createdAt: { gte: cutoffDate },
      reviews: { some: {} },
    },
    include: {
      reviews: true,
      incomeSources: true,
      householdMembers: true,
      shelterExpense: true,
      county: true,
    },
  });

  const totalCases = reviewedIntakes.length;
  if (totalCases === 0) {
    log.info("No reviewed cases found for pattern analysis", { stateCode });
    return [];
  }

  const correctedIntakes = reviewedIntakes.filter((i) =>
    i.reviews.some((r) => r.correctionsMade)
  );

  // Analyze characteristic patterns among corrected cases
  const patterns = [];

  for (const correctionType of ["INCOME", "HOUSEHOLD", "DEDUCTION", "OTHER"]) {
    const correctedOfType = correctedIntakes.filter((i) =>
      i.reviews.some((r) => r.correctionsMade && r.correctionType === correctionType)
    );

    if (correctedOfType.length === 0) continue;

    // Pattern: self-employment + income correction
    const selfEmpCorrected = correctedOfType.filter((i) =>
      i.incomeSources.some((s) => s.incomeType === "SELF_EMPLOYMENT")
    );
    if (selfEmpCorrected.length > 0) {
      patterns.push({
        stateCode,
        correctionType,
        patternName: "self_employment",
        occurrenceCount: selfEmpCorrected.length,
        totalCasesAnalyzed: totalCases,
        errorRate: selfEmpCorrected.length / totalCases,
      });
    }

    // Pattern: large household (4+) + correction
    const largeHhCorrected = correctedOfType.filter(
      (i) => i.householdMembers.filter((m) => m.inSnapHousehold).length >= 3
    );
    if (largeHhCorrected.length > 0) {
      patterns.push({
        stateCode,
        correctionType,
        patternName: "large_household",
        occurrenceCount: largeHhCorrected.length,
        totalCasesAnalyzed: totalCases,
        errorRate: largeHhCorrected.length / totalCases,
      });
    }

    // Pattern: zero/low income with shelter
    const zeroIncomeCorrected = correctedOfType.filter((i) => {
      const totalIncome = i.incomeSources.reduce(
        (sum, s) => sum + (s.snapMonthlyAmount || s.grossAmountPerPeriod || 0),
        0
      );
      return totalIncome < 100 && i.shelterExpense && (i.shelterExpense.rentOrMortgage || 0) > 0;
    });
    if (zeroIncomeCorrected.length > 0) {
      patterns.push({
        stateCode,
        correctionType,
        patternName: "zero_income_with_shelter",
        occurrenceCount: zeroIncomeCorrected.length,
        totalCasesAnalyzed: totalCases,
        errorRate: zeroIncomeCorrected.length / totalCases,
      });
    }

    // Pattern: multiple adults no income
    const multiAdultCorrected = correctedOfType.filter((i) => {
      const noIncomeAdults = i.householdMembers.filter(
        (m) =>
          m.inSnapHousehold &&
          !m.hasEarnedIncome &&
          !m.hasUnearnedIncome &&
          m.ageRange !== "under 18" &&
          !(m.ageRange && m.ageRange.startsWith("0-"))
      );
      return noIncomeAdults.length >= 2;
    });
    if (multiAdultCorrected.length > 0) {
      patterns.push({
        stateCode,
        correctionType,
        patternName: "multiple_adults_no_income",
        occurrenceCount: multiAdultCorrected.length,
        totalCasesAnalyzed: totalCases,
        errorRate: multiAdultCorrected.length / totalCases,
      });
    }

    // Overall correction rate for this type
    patterns.push({
      stateCode,
      correctionType,
      patternName: "overall",
      occurrenceCount: correctedOfType.length,
      totalCasesAnalyzed: totalCases,
      errorRate: correctedOfType.length / totalCases,
    });
  }

  // Upsert patterns into the database
  for (const pattern of patterns) {
    await prisma.errorPattern.upsert({
      where: {
        stateCode_correctionType_patternName: {
          stateCode: pattern.stateCode,
          correctionType: pattern.correctionType,
          patternName: pattern.patternName,
        },
      },
      update: {
        occurrenceCount: pattern.occurrenceCount,
        totalCasesAnalyzed: pattern.totalCasesAnalyzed,
        errorRate: pattern.errorRate,
        lastRefreshed: new Date(),
      },
      create: {
        ...pattern,
        riskWeight: 1.0,
      },
    });
  }

  log.info("Error patterns refreshed", {
    stateCode,
    totalCases,
    correctedCases: correctedIntakes.length,
    patternsGenerated: patterns.length,
  });

  return patterns;
}

// ─── State-Specific Rule Complexity ─────────────────────────────────

/**
 * Returns additional risk weight based on state-specific rule complexity.
 * States with BBCE, waivers, or special programs have more room for error.
 */
async function getStateComplexityWeight(stateCode) {
  let weight = 0;

  const [snapConfig, medicaidConfig] = await Promise.all([
    prisma.snapConfig.findUnique({ where: { stateCode } }),
    prisma.medicaidConfig.findUnique({ where: { stateCode } }),
  ]);

  if (snapConfig) {
    // BBCE states have different income/asset rules — more room for error
    if (snapConfig.bbce) weight += 3;
    // Custom gross income percentages differ from federal
    if (snapConfig.grossIncomePct && snapConfig.grossIncomePct !== 130) weight += 2;
    // Custom asset limits
    if (snapConfig.assetLimit) weight += 1;
  }

  if (medicaidConfig) {
    // Waivers add complexity
    if (medicaidConfig.waiverDetails) weight += 2;
    // Coverage gap states have additional eligibility nuances
    if (medicaidConfig.coverageGap) weight += 1;
  }

  return weight;
}

// ─── Historical Pattern Boost ───────────────────────────────────────

/**
 * Look up cached error patterns for the case's state and apply a score
 * boost based on how often similar cases have had corrections.
 */
async function getHistoricalPatternBoost(intake, stateCode) {
  const patterns = await prisma.errorPattern.findMany({
    where: { stateCode },
  });

  if (patterns.length === 0) return { boost: 0, matchedPatterns: [] };

  let boost = 0;
  const matchedPatterns = [];

  const hasSelfEmployment = (intake.incomeSources || []).some(
    (s) => s.incomeType === "SELF_EMPLOYMENT"
  );
  const householdSize =
    (intake.householdMembers || []).filter((m) => m.inSnapHousehold).length + 1;
  const hasZeroIncome =
    (intake.incomeSources || []).reduce(
      (sum, s) => sum + (s.snapMonthlyAmount || s.grossAmountPerPeriod || 0),
      0
    ) < 100;

  for (const pattern of patterns) {
    let matches = false;

    switch (pattern.patternName) {
      case "self_employment":
        matches = hasSelfEmployment;
        break;
      case "large_household":
        matches = householdSize >= 4;
        break;
      case "zero_income_with_shelter":
        matches =
          hasZeroIncome &&
          intake.shelterExpense &&
          (intake.shelterExpense.rentOrMortgage || 0) > 0;
        break;
      case "multiple_adults_no_income": {
        const noIncomeAdults = (intake.householdMembers || []).filter(
          (m) =>
            m.inSnapHousehold &&
            !m.hasEarnedIncome &&
            !m.hasUnearnedIncome &&
            m.ageRange !== "under 18" &&
            !(m.ageRange && m.ageRange.startsWith("0-"))
        );
        matches = noIncomeAdults.length >= 2;
        break;
      }
      case "overall":
        // Overall correction rate adds a baseline boost
        matches = true;
        break;
    }

    if (matches && pattern.errorRate > 0) {
      // Scale the boost by error rate and risk weight
      // A 20% error rate with weight 1.0 adds ~4 points
      const patternBoost = Math.round(pattern.errorRate * 20 * pattern.riskWeight);
      boost += patternBoost;
      matchedPatterns.push({
        pattern: pattern.patternName,
        correctionType: pattern.correctionType,
        errorRate: `${(pattern.errorRate * 100).toFixed(1)}%`,
        boost: patternBoost,
      });
    }
  }

  // Cap historical boost at 20 points so it augments rather than dominates
  return {
    boost: Math.min(20, boost),
    matchedPatterns,
  };
}

// ─── Main Scoring Function ──────────────────────────────────────────

/**
 * Calculate the predictive risk score for an intake case.
 *
 * @param {Object} intake - Full intake record with relations loaded
 * @param {Object} calculations - Output from calculateFullEligibility()
 * @param {string} stateCode - Two-letter state code for the county
 * @returns {{ predictiveScore, riskLevel, requiresReview, factors, historicalPatterns }}
 */
async function calculatePredictiveScore(intake, calculations, stateCode) {
  const factors = [];
  let rawScore = 0;

  // 1. Evaluate each risk factor against the case data
  for (const factor of RISK_FACTORS) {
    const result = factor.evaluate(intake, calculations);
    if (result.score > 0) {
      rawScore += result.score;
      factors.push({
        name: factor.name,
        description: factor.description,
        score: result.score,
        maxScore: factor.baseWeight,
        detail: result.detail,
      });
    }
  }

  // 2. Add state complexity weight
  const stateWeight = await getStateComplexityWeight(stateCode);
  if (stateWeight > 0) {
    rawScore += stateWeight;
    factors.push({
      name: "state_rule_complexity",
      description: "State-specific rule complexity increases error risk",
      score: stateWeight,
      maxScore: 9,
      detail: `State ${stateCode} has ${stateWeight} complexity points`,
    });
  }

  // 3. Add historical pattern boost
  const { boost, matchedPatterns } = await getHistoricalPatternBoost(intake, stateCode);
  if (boost > 0) {
    rawScore += boost;
    factors.push({
      name: "historical_error_patterns",
      description: "Historical correction data for similar cases in this state",
      score: boost,
      maxScore: 20,
      detail: `${matchedPatterns.length} historical pattern(s) matched`,
    });
  }

  // Clamp score to 0-100
  const predictiveScore = Math.min(100, Math.max(0, rawScore));

  // Determine risk level and review requirement
  let riskLevel;
  if (predictiveScore >= HIGH_RISK_THRESHOLD) {
    riskLevel = "HIGH";
  } else if (predictiveScore >= MEDIUM_RISK_THRESHOLD) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  const requiresReview = predictiveScore >= HIGH_RISK_THRESHOLD;

  log.info("Predictive score calculated", {
    intakeId: intake.id,
    predictiveScore,
    riskLevel,
    requiresReview,
    factorCount: factors.length,
    stateCode,
  });

  return {
    predictiveScore,
    riskLevel,
    requiresReview,
    factors,
    historicalPatterns: matchedPatterns,
  };
}

/**
 * Get a human-readable summary of the risk assessment for caseworker display.
 */
function formatRiskSummary(prediction) {
  const { predictiveScore, riskLevel, requiresReview, factors } = prediction;

  const topFactors = factors
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((f) => f.detail || f.description);

  return {
    score: predictiveScore,
    level: riskLevel,
    requiresReview,
    summary:
      riskLevel === "HIGH"
        ? `High error risk (${predictiveScore}/100) — mandatory review before benefits determination`
        : riskLevel === "MEDIUM"
          ? `Moderate error risk (${predictiveScore}/100) — review recommended`
          : `Low error risk (${predictiveScore}/100) — standard processing`,
    topRiskFactors: topFactors,
  };
}

/**
 * Get aggregate accuracy statistics for a county — useful for admin dashboards.
 */
async function getAccuracyStats(countyId) {
  const [totalReviewed, totalCorrected, byType, avgScore] = await Promise.all([
    prisma.intakeReview.count({
      where: { intake: { countyId } },
    }),
    prisma.intakeReview.count({
      where: { intake: { countyId }, correctionsMade: true },
    }),
    prisma.intakeReview.groupBy({
      by: ["correctionType"],
      where: { intake: { countyId }, correctionsMade: true },
      _count: true,
    }),
    prisma.intake.aggregate({
      where: { countyId, predictiveScore: { not: null } },
      _avg: { predictiveScore: true },
    }),
  ]);

  const correctionRate = totalReviewed > 0 ? totalCorrected / totalReviewed : 0;

  // Break down by correction type
  const correctionsByType = {};
  for (const group of byType) {
    if (group.correctionType) {
      correctionsByType[group.correctionType] = group._count;
    }
  }

  return {
    totalReviewed,
    totalCorrected,
    correctionRate: `${(correctionRate * 100).toFixed(1)}%`,
    correctionsByType,
    avgPredictiveScore: Math.round(avgScore._avg.predictiveScore || 0),
  };
}

module.exports = {
  calculatePredictiveScore,
  refreshErrorPatterns,
  formatRiskSummary,
  getAccuracyStats,
  getStateComplexityWeight,
  getHistoricalPatternBoost,
  HIGH_RISK_THRESHOLD,
  MEDIUM_RISK_THRESHOLD,
  RISK_FACTORS,
};
