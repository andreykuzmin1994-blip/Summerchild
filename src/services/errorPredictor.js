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
 *   3. Case characteristics — 17 weighted risk factors covering income,
 *      household, deductions, shelter, and data quality signals
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

  // ─── New Risk Flags (Phase 2) ───────────────────────────────────────
  // Based on USDA FNS QC error analysis: earned income errors are 30-35%
  // of all overpayment dollars, household composition ~12-15%, deductions ~10-14%.

  {
    name: "multiple_income_sources",
    // USDA QC: cases with 3+ income sources have ~2x baseline error rate.
    // Each additional source adds pay-frequency conversion and verification complexity.
    // Probability: ~15-20% error rate among 3+ source cases.
    // Impact: $100-200/mo per misreported source.
    description: "Multiple income sources increase pay-frequency and verification error risk (2x baseline per USDA QC)",
    baseWeight: 10,
    evaluate(intake) {
      const sources = intake.incomeSources || [];
      const count = sources.length;

      if (count <= 2) return { score: 0, detail: null };

      // Each source beyond 2 adds risk — USDA QC shows 2x error rate at 3+ sources
      const score = Math.min(10, (count - 2) * 3);
      return {
        score,
        detail: `${count} income sources reported (each adds conversion/verification risk)`,
      };
    },
  },

  {
    name: "earned_income_present",
    // USDA QC: cases with earned income are 2-3x more likely to have errors
    // than cases with only unearned/no income. Earned income accounts for
    // 35-40% of all overpayment dollars — the single largest error category.
    // Probability: ~20-30% error rate vs. ~8-10% for unearned-only.
    // Impact: avg $150-200/mo per earned income error.
    description: "Earned income is the #1 overpayment driver — 2-3x error rate vs. unearned-only cases (USDA QC)",
    baseWeight: 8,
    evaluate(intake) {
      const sources = intake.incomeSources || [];
      const earnedSources = sources.filter(
        (s) => s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT"
      );

      if (earnedSources.length === 0) return { score: 0, detail: null };

      // Base risk for any earned income; higher for multiple earned sources
      const score = Math.min(8, 5 + (earnedSources.length - 1) * 2);
      return {
        score,
        detail: `${earnedSources.length} earned income source(s) — earned income cases have 2-3x error rate`,
      };
    },
  },

  {
    name: "homeownership_income_mismatch",
    // Owning a home (property tax or insurance present) while reporting very
    // low income and near-zero liquid resources signals possible unreported
    // assets or income. Home ownership requires equity/down payment/ongoing costs.
    // Probability: ~10-15% error rate for low-income homeowners.
    // Impact: eligibility-affecting (potentially full benefit amount at stake).
    description: "Low income + home ownership + minimal liquid resources signals unreported assets or income",
    baseWeight: 10,
    evaluate(intake, calculations) {
      const shelter = intake.shelterExpense;
      if (!shelter) return { score: 0, detail: null };

      const isHomeowner =
        (shelter.propertyTax || 0) > 0 || (shelter.homeownersInsurance || 0) > 0;
      if (!isHomeowner) return { score: 0, detail: null };

      const grossIncome = calculations?.deductions?.grossIncome ?? 0;
      const liquidResources = intake.liquidResources || 0;

      const details = [];
      let score = 0;

      // Homeowner with very low income
      if (grossIncome < 1200) {
        score += 6;
        details.push(`gross income $${grossIncome}/mo with owned home`);
      }

      // Homeowner with near-zero liquid resources (where are the reserves?)
      if (liquidResources < 100 && grossIncome < 2000) {
        score += 4;
        details.push(`only $${liquidResources} liquid resources`);
      }

      if (score === 0) return { score: 0, detail: null };

      return {
        score: Math.min(10, score),
        detail: `Homeowner paradox: ${details.join(", ")}`,
      };
    },
  },

  {
    name: "income_amount_variance",
    // When the pre-calculated snapMonthlyAmount diverges significantly from
    // the raw grossAmountPerPeriod × frequency multiplier, it signals either
    // applicant rounding/estimation error or a conversion mistake.
    // Probability: ~8-10% of cases have >10% variance.
    // Impact: directly changes benefit amount proportionally.
    description: "Variance between reported and calculated monthly income suggests rounding or conversion error",
    baseWeight: 9,
    evaluate(intake) {
      const FREQ_MULT = { WEEKLY: 4.333, BIWEEKLY: 2.167, SEMI_MONTHLY: 2, MONTHLY: 1 };
      const sources = intake.incomeSources || [];
      let maxVariancePct = 0;
      let worstSource = null;

      for (const source of sources) {
        if (source.incomeType === "SELF_EMPLOYMENT") continue; // handled separately
        if (!source.snapMonthlyAmount || !source.grossAmountPerPeriod) continue;

        const mult = FREQ_MULT[source.payFrequency];
        if (!mult) continue;

        const calculated = Math.round(source.grossAmountPerPeriod * mult * 100) / 100;
        if (calculated === 0) continue;

        const variance = Math.abs(source.snapMonthlyAmount - calculated) / calculated;
        if (variance > maxVariancePct) {
          maxVariancePct = variance;
          worstSource = source;
        }
      }

      if (maxVariancePct < 0.10) return { score: 0, detail: null };

      const pct = Math.round(maxVariancePct * 100);
      const score = Math.min(9, Math.round(pct / 3));
      return {
        score,
        detail: `${pct}% variance between reported and calculated monthly income for ${worstSource.employerOrPayerName || worstSource.incomeType}`,
      };
    },
  },

  {
    name: "unrelated_adult_in_household",
    // Unrelated adults in the SNAP household create complexity around the
    // "purchases and prepares together" rule. They may be boarders, landlords,
    // or have separate income streams that should be excluded.
    // Probability: ~12-15% error rate for households with unrelated adults.
    // Impact: $80-200/mo (household composition affects both income and benefit).
    description: "Unrelated adults in household complicate SNAP unit determination and income counting",
    baseWeight: 8,
    evaluate(intake) {
      const members = intake.householdMembers || [];

      const unrelatedAdults = members.filter((m) => {
        if (!m.inSnapHousehold) return false;
        if (m.ageRange === "under 18" || (m.ageRange && m.ageRange.startsWith("0-"))) return false;

        const rel = (m.relationshipToApplicant || "").toLowerCase();
        // Flag relationships that aren't immediate family
        return [
          "roommate", "friend", "unrelated", "boarder", "landlord",
          "partner", "boyfriend", "girlfriend", "other",
        ].some((r) => rel.includes(r));
      });

      if (unrelatedAdults.length === 0) return { score: 0, detail: null };

      return {
        score: Math.min(8, 5 + (unrelatedAdults.length - 1) * 3),
        detail: `${unrelatedAdults.length} unrelated adult(s) in SNAP household — verify purchases-and-prepares-together status`,
      };
    },
  },

  {
    name: "age_income_implausibility",
    // High income from elderly (70+) or very young (16-18) members is
    // uncommon and may indicate data entry errors or misattribution.
    // Probability: ~5-8% error rate for age-income outliers.
    // Impact: $100-300/mo if income is misattributed or fabricated.
    description: "Unusually high income for elderly (70+) or minor (16-18) household members",
    baseWeight: 7,
    evaluate(intake) {
      const members = intake.householdMembers || [];
      const incomeSources = intake.incomeSources || [];
      const FREQ_MULT = { WEEKLY: 4.333, BIWEEKLY: 2.167, SEMI_MONTHLY: 2, MONTHLY: 1 };

      const details = [];
      let score = 0;

      for (const member of members) {
        if (!member.inSnapHousehold) continue;

        const match = member.ageRange && member.ageRange.match(/^(\d+)/);
        if (!match) continue;
        const startAge = parseInt(match[1]);

        const memberIncome = incomeSources
          .filter((s) => s.householdMemberId === member.id)
          .reduce((sum, s) => {
            const mult = FREQ_MULT[s.payFrequency] || 1;
            return sum + s.grossAmountPerPeriod * mult;
          }, 0);

        // Elderly 70+ with high earned income (>$2500/mo)
        if (startAge >= 70 && memberIncome > 2500) {
          score += 5;
          details.push(`${member.displayName} (${member.ageRange}) reports $${Math.round(memberIncome)}/mo`);
        }

        // Minor 16-18 with high income (>$2000/mo)
        if (startAge >= 16 && startAge <= 18 && memberIncome > 2000) {
          score += 5;
          details.push(`${member.displayName} (${member.ageRange}) reports $${Math.round(memberIncome)}/mo — unusually high for minor`);
        }
      }

      if (score === 0) return { score: 0, detail: null };

      return {
        score: Math.min(7, score),
        detail: details.join("; "),
      };
    },
  },

  {
    name: "child_support_without_children",
    // Child support paid deduction claimed but no children identified in
    // the household suggests either a non-custodial parent situation (valid
    // but needs verification) or a fraudulent deduction claim.
    // Probability: ~8-12% error rate for child support deductions.
    // Impact: $50-200/mo in deduction amount.
    description: "Child support deduction claimed with no children in household — needs verification of obligation",
    baseWeight: 8,
    evaluate(intake) {
      const childSupportPaid = intake.childSupportPaid || 0;
      if (childSupportPaid <= 0) return { score: 0, detail: null };

      const members = intake.householdMembers || [];
      const hasMinors = members.some((m) => {
        if (!m.inSnapHousehold) return false;
        const rel = (m.relationshipToApplicant || "").toLowerCase();
        const isChild = ["child", "son", "daughter", "son/daughter", "stepchild", "foster child"].some(
          (r) => rel.includes(r)
        );
        if (!isChild) return false;
        return m.ageRange === "under 18" || (m.ageRange && m.ageRange.startsWith("0-"));
      });

      // If they have minor children in household AND pay child support,
      // that's a valid non-custodial parent scenario but still warrants verification
      if (hasMinors) return { score: 0, detail: null };

      return {
        score: 8,
        detail: `$${childSupportPaid}/mo child support paid but no minor children in household — verify court-ordered obligation`,
      };
    },
  },

  {
    name: "benefit_near_maximum",
    // When the estimated benefit is within $50 of the maximum allotment,
    // small errors in income or deductions could push the benefit above
    // the statutory maximum — a clear overpayment QC finding.
    // Probability: ~5-8% of cases near maximum.
    // Impact: any error results in overpayment finding in QC audit.
    description: "Estimated benefit near maximum allotment — small errors become QC findings",
    baseWeight: 7,
    evaluate(intake, calculations) {
      if (!calculations?.benefitEstimate) return { score: 0, detail: null };

      const estimated = calculations.benefitEstimate.estimatedBenefit || 0;
      const maxAllotment = calculations.benefitEstimate.maxAllotment || 0;

      if (maxAllotment <= 0 || estimated <= 0) return { score: 0, detail: null };

      const gap = maxAllotment - estimated;
      // Near max: within $50 of maximum
      if (gap >= 0 && gap <= 50) {
        return {
          score: 7,
          detail: `Benefit $${estimated} is within $${gap} of max allotment $${maxAllotment} — any income/deduction error becomes a QC finding`,
        };
      }

      return { score: 0, detail: null };
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
