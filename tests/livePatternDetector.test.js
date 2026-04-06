import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/**
 * Live Pattern Detector — Data-Driven Pattern Discovery Tests
 *
 * Tests feature extraction, statistical helpers (chi-squared, relative risk),
 * pattern discovery from mock review data, and live scoring.
 */

// Set up prisma mock
const require_ = createRequire(import.meta.url);
const prismaPath = require_.resolve("../src/lib/prisma");

// Default mock state — can be overridden per test
let mockErrorPatterns = [];
let mockReviewedIntakes = [];

require_.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    intake: {
      findMany: () => Promise.resolve(mockReviewedIntakes),
    },
    errorPattern: {
      findMany: () => Promise.resolve(mockErrorPatterns),
      upsert: () => Promise.resolve({}),
    },
    county: {
      findUnique: () => Promise.resolve({ stateCode: "GA" }),
    },
  },
};

const {
  extractFeatures,
  chiSquared,
  relativeRisk,
  discoverPatterns,
  scoreLivePatterns,
  FEATURE_EXTRACTORS,
  MIN_SAMPLE_SIZE,
  MIN_RELATIVE_RISK,
  CHI_SQUARED_CRITICAL,
  MAX_LIVE_SCORE,
} = require_("../src/services/livePatternDetector");

// ─── Helpers ───────────────────────────────────────────────────────

function buildIntake(overrides = {}) {
  return {
    id: "test-intake-1",
    incomeSources: [],
    householdMembers: [],
    shelterExpense: null,
    dependentCareExpense: 0,
    medicalExpenses: 0,
    childSupportPaid: 0,
    expeditedFlag: false,
    ...overrides,
  };
}

function buildReviewedIntake({ corrected = false, correctionType = "INCOME", features = {} } = {}) {
  const intake = buildIntake(features);
  intake.reviews = corrected
    ? [{ correctionsMade: true, correctionType }]
    : [{ correctionsMade: false, correctionType: null }];
  return intake;
}

// ─── Feature Extraction Tests ──────────────────────────────────────

describe("Live Pattern Detector — Feature Extraction", () => {
  it("extracts has_self_employment correctly", () => {
    const withSE = buildIntake({
      incomeSources: [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
    });
    const withoutSE = buildIntake({
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
    });

    expect(extractFeatures(withSE).get("has_self_employment")).toBe(true);
    expect(extractFeatures(withoutSE).get("has_self_employment")).toBe(false);
  });

  it("extracts has_earned_income correctly", () => {
    const withEI = buildIntake({
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1500, payFrequency: "BIWEEKLY" }],
    });
    const withoutEI = buildIntake({
      incomeSources: [{ incomeType: "SSI", grossAmountPerPeriod: 800, payFrequency: "MONTHLY" }],
    });

    expect(extractFeatures(withEI).get("has_earned_income")).toBe(true);
    expect(extractFeatures(withoutEI).get("has_earned_income")).toBe(false);
  });

  it("extracts multiple_income_sources correctly", () => {
    const multi = buildIntake({
      incomeSources: [
        { incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1000, payFrequency: "MONTHLY" },
        { incomeType: "SSI", grossAmountPerPeriod: 800, payFrequency: "MONTHLY" },
        { incomeType: "CHILD_SUPPORT_RECEIVED", grossAmountPerPeriod: 300, payFrequency: "MONTHLY" },
      ],
    });
    const single = buildIntake({
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1000, payFrequency: "MONTHLY" }],
    });

    expect(extractFeatures(multi).get("multiple_income_sources")).toBe(true);
    expect(extractFeatures(single).get("multiple_income_sources")).toBe(false);
  });

  it("extracts household_size_1 (applicant only)", () => {
    const solo = buildIntake({ householdMembers: [] });
    const withMembers = buildIntake({
      householdMembers: [{ inSnapHousehold: true, displayName: "M1" }],
    });

    expect(extractFeatures(solo).get("household_size_1")).toBe(true);
    expect(extractFeatures(withMembers).get("household_size_1")).toBe(false);
  });

  it("extracts household_size_4plus correctly", () => {
    const large = buildIntake({
      householdMembers: [
        { inSnapHousehold: true },
        { inSnapHousehold: true },
        { inSnapHousehold: true },
      ],
    });
    const small = buildIntake({
      householdMembers: [{ inSnapHousehold: true }],
    });

    expect(extractFeatures(large).get("household_size_4plus")).toBe(true);
    expect(extractFeatures(small).get("household_size_4plus")).toBe(false);
  });

  it("extracts has_elderly_member correctly", () => {
    const withElderly = buildIntake({
      householdMembers: [{ isElderly: true, inSnapHousehold: true }],
    });
    const noElderly = buildIntake({
      householdMembers: [{ isElderly: false, inSnapHousehold: true }],
    });

    expect(extractFeatures(withElderly).get("has_elderly_member")).toBe(true);
    expect(extractFeatures(noElderly).get("has_elderly_member")).toBe(false);
  });

  it("extracts zero_income correctly", () => {
    const zero = buildIntake({ incomeSources: [] });
    const hasIncome = buildIntake({
      incomeSources: [{ grossAmountPerPeriod: 500, payFrequency: "MONTHLY" }],
    });

    expect(extractFeatures(zero).get("zero_income")).toBe(true);
    expect(extractFeatures(hasIncome).get("zero_income")).toBe(false);
  });

  it("extracts is_homeowner correctly", () => {
    const owner = buildIntake({
      shelterExpense: { propertyTax: 200, homeownersInsurance: 100, rentOrMortgage: 1000, totalShelterCost: 1300 },
    });
    const renter = buildIntake({
      shelterExpense: { propertyTax: 0, homeownersInsurance: 0, rentOrMortgage: 800, totalShelterCost: 800 },
    });

    expect(extractFeatures(owner).get("is_homeowner")).toBe(true);
    expect(extractFeatures(renter).get("is_homeowner")).toBe(false);
  });

  it("extracts has_unrelated_adult correctly", () => {
    const withRoommate = buildIntake({
      householdMembers: [{ inSnapHousehold: true, relationshipToApplicant: "Roommate" }],
    });
    const withSpouse = buildIntake({
      householdMembers: [{ inSnapHousehold: true, relationshipToApplicant: "Spouse" }],
    });

    expect(extractFeatures(withRoommate).get("has_unrelated_adult")).toBe(true);
    expect(extractFeatures(withSpouse).get("has_unrelated_adult")).toBe(false);
  });

  it("extracts high_expense_ratio correctly", () => {
    const highRatio = buildIntake({
      incomeSources: [{ grossAmountPerPeriod: 1000, snapMonthlyAmount: 1000, payFrequency: "MONTHLY" }],
      shelterExpense: { totalShelterCost: 900, rentOrMortgage: 900 },
    });
    const normalRatio = buildIntake({
      incomeSources: [{ grossAmountPerPeriod: 3000, snapMonthlyAmount: 3000, payFrequency: "MONTHLY" }],
      shelterExpense: { totalShelterCost: 900, rentOrMortgage: 900 },
    });

    expect(extractFeatures(highRatio).get("high_expense_ratio")).toBe(true);
    expect(extractFeatures(normalRatio).get("high_expense_ratio")).toBe(false);
  });

  it("extracts expedited_case correctly", () => {
    const expedited = buildIntake({ expeditedFlag: true });
    const normal = buildIntake({ expeditedFlag: false });

    expect(extractFeatures(expedited).get("expedited_case")).toBe(true);
    expect(extractFeatures(normal).get("expedited_case")).toBe(false);
  });

  it("extracts all features without throwing for empty intake", () => {
    const empty = buildIntake();
    const features = extractFeatures(empty);

    expect(features.size).toBe(FEATURE_EXTRACTORS.length);
    // All should be boolean
    for (const [, value] of features) {
      expect(typeof value).toBe("boolean");
    }
  });
});

// ─── Statistical Helper Tests ──────────────────────────────────────

describe("Live Pattern Detector — Statistical Helpers", () => {
  describe("chiSquared", () => {
    it("returns 0 for empty table", () => {
      expect(chiSquared(0, 0, 0, 0)).toBe(0);
    });

    it("returns 0 when feature has no effect", () => {
      // Equal correction rates: 50% with feature, 50% without
      const result = chiSquared(50, 50, 50, 50);
      // With Yates' correction this is very small
      expect(result).toBeLessThan(CHI_SQUARED_CRITICAL);
    });

    it("returns significant value for strong association", () => {
      // 80% correction rate with feature, 20% without
      // a=80, b=20, c=20, d=80
      const result = chiSquared(80, 20, 20, 80);
      expect(result).toBeGreaterThan(CHI_SQUARED_CRITICAL);
    });

    it("handles zero in one cell", () => {
      // All feature cases corrected, no non-feature cases corrected
      const result = chiSquared(10, 0, 0, 10);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe("relativeRisk", () => {
    it("returns 1 when feature has no effect", () => {
      // 50% with, 50% without
      expect(relativeRisk(50, 50, 50, 50)).toBe(1);
    });

    it("returns > 1 when feature increases correction risk", () => {
      // 80% with feature, 20% without
      const rr = relativeRisk(80, 20, 20, 80);
      expect(rr).toBe(4); // 0.8 / 0.2
    });

    it("returns < 1 when feature decreases correction risk", () => {
      // 20% with feature, 80% without
      const rr = relativeRisk(20, 80, 80, 20);
      expect(rr).toBe(0.25); // 0.2 / 0.8
    });

    it("returns Infinity when no-feature group has zero corrections", () => {
      const rr = relativeRisk(10, 5, 0, 50);
      expect(rr).toBe(Infinity);
    });

    it("returns 1 when both groups have zero corrections", () => {
      const rr = relativeRisk(0, 10, 0, 50);
      expect(rr).toBe(1);
    });
  });
});

// ─── Pattern Discovery Tests ───────────────────────────────────────

describe("Live Pattern Detector — Pattern Discovery", () => {
  it("returns insufficient data when not enough reviewed cases", async () => {
    mockReviewedIntakes = [];

    const result = await discoverPatterns("GA");

    expect(result.insufficientData).toBe(true);
    expect(result.patternsDiscovered).toBe(0);
  });

  it("discovers single-feature patterns from correction data", async () => {
    // Create 30 reviewed intakes: self-employment cases get corrected 80% of the time,
    // non-self-employment cases get corrected 20% of the time
    const intakes = [];
    for (let i = 0; i < 15; i++) {
      // Self-employment cases — 12 corrected, 3 not
      intakes.push(buildReviewedIntake({
        corrected: i < 12,
        features: {
          incomeSources: [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
        },
      }));
    }
    for (let i = 0; i < 15; i++) {
      // Non-self-employment cases — 3 corrected, 12 not
      intakes.push(buildReviewedIntake({
        corrected: i < 3,
        features: {
          incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
        },
      }));
    }

    mockReviewedIntakes = intakes;

    const result = await discoverPatterns("GA", { minSampleSize: 10 });

    expect(result.insufficientData).toBe(false);
    expect(result.totalCases).toBe(30);
    expect(result.singlePatterns.length).toBeGreaterThan(0);

    // has_self_employment should be discovered with high relative risk
    const sePattern = result.singlePatterns.find((p) => p.feature === "has_self_employment");
    expect(sePattern).toBeDefined();
    expect(sePattern.relativeRisk).toBeGreaterThan(1.3);
  });

  it("filters out features below minimum relative risk", async () => {
    // Create cases where correction rate is similar for all features
    const intakes = [];
    for (let i = 0; i < 30; i++) {
      intakes.push(buildReviewedIntake({
        corrected: i % 3 === 0, // ~33% correction rate regardless of features
        features: {
          incomeSources: i < 15
            ? [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }]
            : [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
        },
      }));
    }

    mockReviewedIntakes = intakes;

    const result = await discoverPatterns("GA", { minSampleSize: 10, minRelativeRisk: 2.0 });

    // With similar correction rates, no feature should have RR > 2.0
    const highRRPatterns = result.singlePatterns.filter((p) => p.relativeRisk >= 2.0);
    expect(highRRPatterns.length).toBe(0);
  });

  it("computes base rate correctly", async () => {
    const intakes = [];
    for (let i = 0; i < 20; i++) {
      intakes.push(buildReviewedIntake({
        corrected: i < 8, // 40% base rate
        features: { incomeSources: [] },
      }));
    }

    mockReviewedIntakes = intakes;

    const result = await discoverPatterns("GA", { minSampleSize: 10 });

    expect(result.baseRate).toBe(0.4);
    expect(result.totalCorrected).toBe(8);
  });
});

// ─── Live Scoring Tests ────────────────────────────────────────────

describe("Live Pattern Detector — Live Scoring", () => {
  it("returns 0 when no live patterns exist", async () => {
    mockErrorPatterns = [];

    const intake = buildIntake();
    const result = await scoreLivePatterns(intake, "GA");

    expect(result.score).toBe(0);
    expect(result.matchedPatterns).toEqual([]);
  });

  it("scores against single-feature live pattern", async () => {
    mockErrorPatterns = [
      {
        patternName: "live_has_self_employment",
        stateCode: "GA",
        errorRate: 0.4,
        riskWeight: 2.0,
        characteristics: {
          type: "single",
          features: ["has_self_employment"],
          relativeRisk: 2.0,
        },
      },
    ];

    const intake = buildIntake({
      incomeSources: [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 3000, payFrequency: "MONTHLY" }],
    });

    const result = await scoreLivePatterns(intake, "GA");

    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedPatterns.length).toBe(1);
    expect(result.matchedPatterns[0].pattern).toBe("has_self_employment");
  });

  it("does not match when feature is absent", async () => {
    mockErrorPatterns = [
      {
        patternName: "live_has_self_employment",
        stateCode: "GA",
        errorRate: 0.4,
        riskWeight: 2.0,
        characteristics: {
          type: "single",
          features: ["has_self_employment"],
          relativeRisk: 2.0,
        },
      },
    ];

    const intake = buildIntake({
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "BIWEEKLY" }],
    });

    const result = await scoreLivePatterns(intake, "GA");

    expect(result.score).toBe(0);
    expect(result.matchedPatterns.length).toBe(0);
  });

  it("scores against pair pattern only when both features present", async () => {
    mockErrorPatterns = [
      {
        patternName: "live_has_self_employment+is_homeowner",
        stateCode: "GA",
        errorRate: 0.6,
        riskWeight: 2.5,
        characteristics: {
          type: "pair",
          features: ["has_self_employment", "is_homeowner"],
          relativeRisk: 2.5,
        },
      },
    ];

    // Both features present
    const bothPresent = buildIntake({
      incomeSources: [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 3000, payFrequency: "MONTHLY" }],
      shelterExpense: { propertyTax: 300, homeownersInsurance: 100, rentOrMortgage: 1200, totalShelterCost: 1600 },
    });

    const result1 = await scoreLivePatterns(bothPresent, "GA");
    expect(result1.score).toBeGreaterThan(0);
    expect(result1.matchedPatterns[0].type).toBe("pair");

    // Only one feature present
    const onlyOne = buildIntake({
      incomeSources: [{ incomeType: "SELF_EMPLOYMENT", grossAmountPerPeriod: 3000, payFrequency: "MONTHLY" }],
      shelterExpense: { propertyTax: 0, homeownersInsurance: 0, rentOrMortgage: 800, totalShelterCost: 800 },
    });

    const result2 = await scoreLivePatterns(onlyOne, "GA");
    expect(result2.score).toBe(0);
  });

  it("caps score at MAX_LIVE_SCORE", async () => {
    // Stack multiple high-scoring patterns
    mockErrorPatterns = [
      {
        patternName: "live_has_self_employment",
        stateCode: "GA",
        errorRate: 0.8,
        riskWeight: 3.0,
        characteristics: { type: "single", features: ["has_self_employment"], relativeRisk: 3.0 },
      },
      {
        patternName: "live_zero_income",
        stateCode: "GA",
        errorRate: 0.7,
        riskWeight: 3.0,
        characteristics: { type: "single", features: ["zero_income"], relativeRisk: 3.0 },
      },
      {
        patternName: "live_has_elderly_member",
        stateCode: "GA",
        errorRate: 0.6,
        riskWeight: 3.0,
        characteristics: { type: "single", features: ["has_elderly_member"], relativeRisk: 3.0 },
      },
    ];

    // Intake matches all three — but none of these match simultaneously in reality.
    // zero_income requires no income, self_employment provides income.
    // Let's just test the cap works: use a case that matches 2 of 3.
    const intake = buildIntake({
      incomeSources: [], // zero income — matches zero_income
      householdMembers: [{ isElderly: true, inSnapHousehold: true }], // matches elderly
    });

    const result = await scoreLivePatterns(intake, "GA");

    expect(result.score).toBeLessThanOrEqual(MAX_LIVE_SCORE);
  });

  it("includes feature snapshot in results", async () => {
    mockErrorPatterns = [];

    const intake = buildIntake({
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 2000, payFrequency: "MONTHLY" }],
      expeditedFlag: true,
    });

    const result = await scoreLivePatterns(intake, "GA");

    expect(result.featureSnapshot).toBeDefined();
    expect(result.featureSnapshot.has_earned_income).toBe(true);
    expect(result.featureSnapshot.expedited_case).toBe(true);
    expect(result.featureSnapshot.has_self_employment).toBe(false);
  });
});

// ─── Constants & Structure Tests ───────────────────────────────────

describe("Live Pattern Detector — Constants & Structure", () => {
  it("has reasonable threshold defaults", () => {
    expect(MIN_SAMPLE_SIZE).toBeGreaterThanOrEqual(10);
    expect(MIN_RELATIVE_RISK).toBeGreaterThan(1);
    expect(CHI_SQUARED_CRITICAL).toBeCloseTo(3.841, 2);
    expect(MAX_LIVE_SCORE).toBeGreaterThan(0);
    expect(MAX_LIVE_SCORE).toBeLessThanOrEqual(30);
  });

  it("all feature extractors have name and extract function", () => {
    for (const extractor of FEATURE_EXTRACTORS) {
      expect(typeof extractor.name).toBe("string");
      expect(extractor.name.length).toBeGreaterThan(0);
      expect(typeof extractor.extract).toBe("function");
    }
  });

  it("feature extractor names are unique", () => {
    const names = FEATURE_EXTRACTORS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("feature extractors do not throw for minimal intake", () => {
    const minimal = { incomeSources: [], householdMembers: [] };
    for (const extractor of FEATURE_EXTRACTORS) {
      expect(() => extractor.extract(minimal)).not.toThrow();
    }
  });
});
