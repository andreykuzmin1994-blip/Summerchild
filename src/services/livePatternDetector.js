/**
 * Live Pattern Detector — Data-Driven Error Pattern Discovery
 *
 * Unlike the hardcoded RISK_FACTORS in errorPredictor.js, this module
 * discovers which case characteristics correlate with corrections by
 * analyzing actual IntakeReview data. No pre-programmed risk judgments —
 * the data tells us what matters.
 *
 * How it works:
 *   1. Extract neutral binary features from every reviewed intake
 *      (e.g., "has self-employment", "household size 4+", "homeowner")
 *   2. Build contingency tables: feature present vs. absent × corrected vs. not
 *   3. Compute relative risk (lift) for each feature
 *   4. Test statistical significance via chi-squared approximation
 *   5. Discover feature PAIRS where the combination has higher lift
 *      than either feature alone (interaction effects)
 *   6. Store discovered patterns in ErrorPattern table for live scoring
 *
 * The key difference from errorPredictor's RISK_FACTORS:
 *   - RISK_FACTORS are expert-designed heuristics with static weights
 *   - This module's weights come from actual correction data
 *   - New patterns emerge automatically as review history accumulates
 */

const prisma = require("../lib/prisma");
const { child } = require("./logger");
const log = child("live-pattern-detector");

// Minimum cases required before a pattern is considered reliable
const MIN_SAMPLE_SIZE = 20;
// Minimum occurrences of feature+correction to avoid noise
const MIN_OCCURRENCES = 3;
// Minimum relative risk to qualify as a meaningful pattern
const MIN_RELATIVE_RISK = 1.3;
// Chi-squared critical value for p < 0.05 with 1 df
const CHI_SQUARED_CRITICAL = 3.841;
// How many days of review history to analyze
const HISTORY_WINDOW_DAYS = 180;
// Maximum number of feature pairs to evaluate (top N single features)
const MAX_PAIR_CANDIDATES = 10;
// Cap on live pattern score contribution to the overall predictive score
const MAX_LIVE_SCORE = 25;

// ─── Feature Extractors ────────────────────────────────────────────
// Each extractor pulls a neutral binary trait from an intake.
// These are facts, not risk judgments — the data decides which matter.

const FEATURE_EXTRACTORS = [
  {
    name: "has_self_employment",
    extract: (intake) =>
      (intake.incomeSources || []).some((s) => s.incomeType === "SELF_EMPLOYMENT"),
  },
  {
    name: "has_earned_income",
    extract: (intake) =>
      (intake.incomeSources || []).some((s) => s.incomeType === "EMPLOYMENT"),
  },
  {
    name: "multiple_income_sources",
    extract: (intake) => (intake.incomeSources || []).length >= 3,
  },
  {
    name: "monthly_pay_reported",
    extract: (intake) =>
      (intake.incomeSources || []).some(
        (s) => s.payFrequency === "MONTHLY" && s.incomeType === "EMPLOYMENT"
      ),
  },
  {
    name: "weekly_pay_reported",
    extract: (intake) =>
      (intake.incomeSources || []).some(
        (s) => s.payFrequency === "WEEKLY" && s.incomeType === "EMPLOYMENT"
      ),
  },
  {
    name: "household_size_1",
    extract: (intake) =>
      (intake.householdMembers || []).filter((m) => m.inSnapHousehold).length === 0,
  },
  {
    name: "household_size_4plus",
    extract: (intake) =>
      (intake.householdMembers || []).filter((m) => m.inSnapHousehold).length >= 3,
  },
  {
    name: "has_elderly_member",
    extract: (intake) =>
      (intake.householdMembers || []).some((m) => m.isElderly && m.inSnapHousehold),
  },
  {
    name: "has_disabled_member",
    extract: (intake) =>
      (intake.householdMembers || []).some((m) => m.isDisabled && m.inSnapHousehold),
  },
  {
    name: "has_unrelated_adult",
    extract: (intake) =>
      (intake.householdMembers || []).some(
        (m) =>
          m.inSnapHousehold &&
          m.relationshipToApplicant &&
          ["roommate", "unrelated", "other"].includes(
            m.relationshipToApplicant.toLowerCase()
          )
      ),
  },
  {
    name: "zero_income",
    extract: (intake) => {
      const total = (intake.incomeSources || []).reduce(
        (sum, s) => sum + (s.snapMonthlyAmount || s.grossAmountPerPeriod || 0),
        0
      );
      return total < 1;
    },
  },
  {
    name: "low_income_under_500",
    extract: (intake) => {
      const total = (intake.incomeSources || []).reduce(
        (sum, s) => sum + (s.snapMonthlyAmount || s.grossAmountPerPeriod || 0),
        0
      );
      return total > 0 && total < 500;
    },
  },
  {
    name: "has_shelter_cost",
    extract: (intake) =>
      intake.shelterExpense && (intake.shelterExpense.rentOrMortgage || 0) > 0,
  },
  {
    name: "is_homeowner",
    extract: (intake) =>
      intake.shelterExpense &&
      ((intake.shelterExpense.propertyTax || 0) > 0 ||
        (intake.shelterExpense.homeownersInsurance || 0) > 0),
  },
  {
    name: "has_dependent_care",
    extract: (intake) => (intake.dependentCareExpense || 0) > 0,
  },
  {
    name: "has_medical_expenses",
    extract: (intake) => (intake.medicalExpenses || 0) > 0,
  },
  {
    name: "has_child_support_paid",
    extract: (intake) => (intake.childSupportPaid || 0) > 0,
  },
  {
    name: "no_income_adults_present",
    extract: (intake) => {
      const members = intake.householdMembers || [];
      return members.some(
        (m) =>
          m.inSnapHousehold &&
          !m.hasEarnedIncome &&
          !m.hasUnearnedIncome &&
          !m.isElderly &&
          !m.isDisabled &&
          m.ageRange !== "under 18" &&
          !(m.ageRange && m.ageRange.startsWith("0-"))
      );
    },
  },
  {
    name: "high_expense_ratio",
    extract: (intake) => {
      const totalIncome = (intake.incomeSources || []).reduce(
        (sum, s) => sum + (s.snapMonthlyAmount || s.grossAmountPerPeriod || 0),
        0
      );
      const shelter = intake.shelterExpense
        ? (intake.shelterExpense.totalShelterCost || 0)
        : 0;
      return totalIncome > 0 && shelter > totalIncome * 0.8;
    },
  },
  {
    name: "expedited_case",
    extract: (intake) => intake.expeditedFlag === true,
  },
];

// ─── Feature Extraction ────────────────────────────────────────────

/**
 * Extract all binary features from an intake record.
 * Returns a Map of featureName → boolean.
 */
function extractFeatures(intake) {
  const features = new Map();
  for (const extractor of FEATURE_EXTRACTORS) {
    try {
      features.set(extractor.name, !!extractor.extract(intake));
    } catch {
      features.set(extractor.name, false);
    }
  }
  return features;
}

// ─── Statistical Helpers ───────────────────────────────────────────

/**
 * Compute chi-squared statistic for a 2×2 contingency table.
 *
 *                Corrected    Not Corrected
 *  Feature       a            b
 *  No Feature    c            d
 *
 * Uses Yates' correction for continuity.
 */
function chiSquared(a, b, c, d) {
  const n = a + b + c + d;
  if (n === 0) return 0;

  const numerator = n * Math.pow(Math.abs(a * d - b * c) - n / 2, 2);
  const denom = (a + b) * (c + d) * (a + c) * (b + d);
  if (denom === 0) return 0;

  return numerator / denom;
}

/**
 * Compute relative risk: P(correction | feature) / P(correction | no feature)
 * Returns Infinity if denominator is 0, or 0 if numerator is 0.
 */
function relativeRisk(a, b, c, d) {
  const pCorrGivenFeature = (a + b) > 0 ? a / (a + b) : 0;
  const pCorrGivenNoFeature = (c + d) > 0 ? c / (c + d) : 0;

  if (pCorrGivenNoFeature === 0) return pCorrGivenFeature > 0 ? Infinity : 1;
  return pCorrGivenFeature / pCorrGivenNoFeature;
}

// ─── Pattern Discovery ─────────────────────────────────────────────

/**
 * Discover error patterns from historical IntakeReview data.
 *
 * Analyzes reviewed intakes, extracts features, computes which features
 * (and feature pairs) are statistically associated with corrections.
 * Stores discovered patterns in the ErrorPattern table.
 *
 * @param {string} stateCode - Two-letter state code
 * @param {Object} [options]
 * @param {number} [options.minSampleSize] - Override MIN_SAMPLE_SIZE
 * @param {number} [options.minRelativeRisk] - Override MIN_RELATIVE_RISK
 * @param {string} [options.correctionType] - Filter to specific correction type
 * @returns {Object} Discovery results with patterns and stats
 */
async function discoverPatterns(stateCode, options = {}) {
  const minSamples = options.minSampleSize || MIN_SAMPLE_SIZE;
  const minRR = options.minRelativeRisk || MIN_RELATIVE_RISK;
  const correctionTypeFilter = options.correctionType || null;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - HISTORY_WINDOW_DAYS);

  // Fetch all reviewed intakes for this state
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
    },
  });

  const totalCases = reviewedIntakes.length;
  if (totalCases < minSamples) {
    log.info("Insufficient reviewed cases for pattern discovery", {
      stateCode,
      totalCases,
      minRequired: minSamples,
    });
    return {
      stateCode,
      totalCases,
      insufficientData: true,
      patternsDiscovered: 0,
      patterns: [],
    };
  }

  // Classify each intake: corrected or not
  const caseData = reviewedIntakes.map((intake) => {
    const corrected = correctionTypeFilter
      ? intake.reviews.some(
          (r) => r.correctionsMade && r.correctionType === correctionTypeFilter
        )
      : intake.reviews.some((r) => r.correctionsMade);

    return {
      intake,
      corrected,
      features: extractFeatures(intake),
    };
  });

  const totalCorrected = caseData.filter((c) => c.corrected).length;
  const baseRate = totalCorrected / totalCases;

  // ── Single-feature analysis ──────────────────────────────────────

  const singleResults = [];

  for (const extractor of FEATURE_EXTRACTORS) {
    const fname = extractor.name;

    // Build contingency table
    let a = 0, b = 0, c = 0, d = 0;
    for (const caseItem of caseData) {
      const hasFeature = caseItem.features.get(fname);
      if (hasFeature && caseItem.corrected) a++;
      else if (hasFeature && !caseItem.corrected) b++;
      else if (!hasFeature && caseItem.corrected) c++;
      else d++;
    }

    const featureCount = a + b;
    if (featureCount < MIN_OCCURRENCES || a < MIN_OCCURRENCES) continue;

    const rr = relativeRisk(a, b, c, d);
    const chi2 = chiSquared(a, b, c, d);
    const correctionRate = featureCount > 0 ? a / featureCount : 0;

    if (rr >= minRR && chi2 >= CHI_SQUARED_CRITICAL) {
      singleResults.push({
        featureName: fname,
        type: "single",
        relativeRisk: rr,
        chiSquared: chi2,
        correctionRate,
        baseRate,
        lift: rr,
        featureCount,
        correctedWithFeature: a,
        contingency: { a, b, c, d },
      });
    }
  }

  // Sort by relative risk descending
  singleResults.sort((x, y) => y.relativeRisk - x.relativeRisk);

  // ── Feature-pair analysis (interaction effects) ──────────────────

  const pairResults = [];

  // Only check pairs among the top single-feature candidates
  const topFeatures = singleResults
    .slice(0, MAX_PAIR_CANDIDATES)
    .map((r) => r.featureName);

  // Also include features that are common (>10% of cases) even if not significant alone
  for (const extractor of FEATURE_EXTRACTORS) {
    const count = caseData.filter((c) => c.features.get(extractor.name)).length;
    if (count >= totalCases * 0.1 && !topFeatures.includes(extractor.name)) {
      topFeatures.push(extractor.name);
    }
    if (topFeatures.length >= MAX_PAIR_CANDIDATES * 2) break;
  }

  for (let i = 0; i < topFeatures.length; i++) {
    for (let j = i + 1; j < topFeatures.length; j++) {
      const f1 = topFeatures[i];
      const f2 = topFeatures[j];

      // Contingency for the combination
      let a = 0, b = 0, c = 0, d = 0;
      for (const caseItem of caseData) {
        const hasBoth = caseItem.features.get(f1) && caseItem.features.get(f2);
        if (hasBoth && caseItem.corrected) a++;
        else if (hasBoth && !caseItem.corrected) b++;
        else if (!hasBoth && caseItem.corrected) c++;
        else d++;
      }

      const pairCount = a + b;
      if (pairCount < MIN_OCCURRENCES || a < MIN_OCCURRENCES) continue;

      const rr = relativeRisk(a, b, c, d);
      const chi2 = chiSquared(a, b, c, d);
      const correctionRate = pairCount > 0 ? a / pairCount : 0;

      // Only keep pairs that beat both individual features
      const f1Result = singleResults.find((r) => r.featureName === f1);
      const f2Result = singleResults.find((r) => r.featureName === f2);
      const maxSingleRR = Math.max(
        f1Result ? f1Result.relativeRisk : 1,
        f2Result ? f2Result.relativeRisk : 1
      );

      if (rr > maxSingleRR && rr >= minRR && chi2 >= CHI_SQUARED_CRITICAL) {
        pairResults.push({
          featureName: `${f1}+${f2}`,
          features: [f1, f2],
          type: "pair",
          relativeRisk: rr,
          chiSquared: chi2,
          correctionRate,
          baseRate,
          lift: rr,
          featureCount: pairCount,
          correctedWithFeature: a,
          interactionGain: rr - maxSingleRR,
          contingency: { a, b, c, d },
        });
      }
    }
  }

  pairResults.sort((x, y) => y.relativeRisk - x.relativeRisk);

  // ── Persist discovered patterns ──────────────────────────────────

  const allPatterns = [...singleResults, ...pairResults];
  const corrType = correctionTypeFilter || "OTHER";

  for (const pattern of allPatterns) {
    const patternName = `live_${pattern.featureName}`;

    await prisma.errorPattern.upsert({
      where: {
        stateCode_correctionType_patternName: {
          stateCode,
          correctionType: corrType,
          patternName,
        },
      },
      update: {
        occurrenceCount: pattern.correctedWithFeature,
        totalCasesAnalyzed: totalCases,
        errorRate: pattern.correctionRate,
        riskWeight: Math.min(3.0, pattern.relativeRisk),
        characteristics: {
          type: pattern.type,
          features: pattern.type === "pair" ? pattern.features : [pattern.featureName],
          relativeRisk: round2(pattern.relativeRisk),
          chiSquared: round2(pattern.chiSquared),
          correctionRate: round2(pattern.correctionRate),
          baseRate: round2(baseRate),
          lift: round2(pattern.lift),
          sampleSize: pattern.featureCount,
          discoveredAt: new Date().toISOString(),
        },
        lastRefreshed: new Date(),
      },
      create: {
        stateCode,
        correctionType: corrType,
        patternName,
        occurrenceCount: pattern.correctedWithFeature,
        totalCasesAnalyzed: totalCases,
        errorRate: pattern.correctionRate,
        riskWeight: Math.min(3.0, pattern.relativeRisk),
        characteristics: {
          type: pattern.type,
          features: pattern.type === "pair" ? pattern.features : [pattern.featureName],
          relativeRisk: round2(pattern.relativeRisk),
          chiSquared: round2(pattern.chiSquared),
          correctionRate: round2(pattern.correctionRate),
          baseRate: round2(baseRate),
          lift: round2(pattern.lift),
          sampleSize: pattern.featureCount,
          discoveredAt: new Date().toISOString(),
        },
      },
    });
  }

  log.info("Live pattern discovery complete", {
    stateCode,
    totalCases,
    totalCorrected,
    baseRate: round2(baseRate),
    singlePatterns: singleResults.length,
    pairPatterns: pairResults.length,
  });

  return {
    stateCode,
    totalCases,
    totalCorrected,
    baseRate: round2(baseRate),
    insufficientData: false,
    patternsDiscovered: allPatterns.length,
    singlePatterns: singleResults.map(formatPatternResult),
    pairPatterns: pairResults.map(formatPatternResult),
  };
}

// ─── Live Scoring ──────────────────────────────────────────────────

/**
 * Score a new intake against discovered live patterns.
 *
 * Loads live_* patterns from ErrorPattern, extracts features from the
 * intake, and returns a weighted score contribution.
 *
 * @param {Object} intake - Full intake with relations loaded
 * @param {string} stateCode - Two-letter state code
 * @returns {{ score, matchedPatterns, featureSnapshot }}
 */
async function scoreLivePatterns(intake, stateCode) {
  // Load only live-discovered patterns (prefixed with "live_")
  const patterns = await prisma.errorPattern.findMany({
    where: {
      stateCode,
      patternName: { startsWith: "live_" },
    },
  });

  const features = extractFeatures(intake);
  const featureSnapshot = Object.fromEntries(features);

  if (patterns.length === 0) {
    return { score: 0, matchedPatterns: [], featureSnapshot };
  }

  let rawScore = 0;
  const matchedPatterns = [];

  for (const pattern of patterns) {
    const chars = pattern.characteristics || {};
    const patternFeatures = chars.features || [];

    // Check if this intake matches the pattern's feature requirements
    const allMatch = patternFeatures.every((f) => features.get(f));
    if (!allMatch) continue;

    // Score contribution: error rate × risk weight × 100, scaled to keep proportionate
    // A pattern with 40% correction rate and 2.0 risk weight → 40 * 2.0 * 0.25 = 20 points
    const contribution = Math.round(
      pattern.errorRate * pattern.riskWeight * 25
    );

    if (contribution > 0) {
      rawScore += contribution;
      matchedPatterns.push({
        pattern: pattern.patternName.replace("live_", ""),
        type: chars.type || "single",
        correctionRate: `${(pattern.errorRate * 100).toFixed(1)}%`,
        relativeRisk: chars.relativeRisk || pattern.riskWeight,
        contribution,
      });
    }
  }

  // Cap the total live pattern contribution
  const score = Math.min(MAX_LIVE_SCORE, rawScore);

  return { score, matchedPatterns, featureSnapshot };
}

// ─── Helpers ───────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatPatternResult(pattern) {
  return {
    feature: pattern.featureName,
    type: pattern.type,
    relativeRisk: round2(pattern.relativeRisk),
    correctionRate: `${(pattern.correctionRate * 100).toFixed(1)}%`,
    baseRate: `${(pattern.baseRate * 100).toFixed(1)}%`,
    chiSquared: round2(pattern.chiSquared),
    sampleSize: pattern.featureCount,
    corrections: pattern.correctedWithFeature,
    ...(pattern.interactionGain !== undefined && {
      interactionGain: round2(pattern.interactionGain),
    }),
  };
}

module.exports = {
  discoverPatterns,
  scoreLivePatterns,
  extractFeatures,
  FEATURE_EXTRACTORS,
  // Exported for testing
  chiSquared,
  relativeRisk,
  MIN_SAMPLE_SIZE,
  MIN_RELATIVE_RISK,
  CHI_SQUARED_CRITICAL,
  MAX_LIVE_SCORE,
};
