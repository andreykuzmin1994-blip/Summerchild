import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/**
 * Accuracy Assistant — Predictive Error Detection Tests
 *
 * Tests the risk factor evaluation functions and predictive scoring
 * that power pre-determination error detection.
 */

// Set up prisma mock with the models errorPredictor.js needs
const require_ = createRequire(import.meta.url);
const prismaPath = require_.resolve("../src/lib/prisma");

require_.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    snapConfig: {
      findUnique: () => Promise.resolve({ bbce: true, grossIncomePct: 130, assetLimit: null }),
    },
    medicaidConfig: {
      findUnique: () => Promise.resolve({ waiverDetails: null, coverageGap: false }),
    },
    errorPattern: {
      findMany: () => Promise.resolve([]),
      upsert: () => Promise.resolve({}),
    },
    intake: {
      findMany: () => Promise.resolve([]),
      aggregate: () => Promise.resolve({ _avg: { predictiveScore: 0 } }),
    },
    intakeReview: {
      count: () => Promise.resolve(0),
      groupBy: () => Promise.resolve([]),
    },
    county: {
      findUnique: () => Promise.resolve({ stateCode: "GA" }),
    },
  },
};

const {
  RISK_FACTORS,
  calculatePredictiveScore,
  formatRiskSummary,
  HIGH_RISK_THRESHOLD,
  MEDIUM_RISK_THRESHOLD,
} = require_("../src/services/errorPredictor");

// Helper: find a risk factor by name
function getFactor(name) {
  return RISK_FACTORS.find((f) => f.name === name);
}

// Helper: build a minimal intake
function buildIntake(overrides = {}) {
  return {
    id: "test-intake-1",
    countyId: "county-1",
    householdMembers: [],
    incomeSources: [],
    shelterExpense: null,
    dependentCareExpense: 0,
    medicalExpenses: 0,
    childSupportPaid: 0,
    consistencyFlags: [],
    ...overrides,
  };
}

// Helper: build minimal calculations
function buildCalc(overrides = {}) {
  return {
    deductions: { grossIncome: 2000, netIncome: 1500, householdSize: 1, deductions: [] },
    expedited: { eligible: false, reasons: [] },
    benefitEstimate: { estimatedBenefit: 200 },
    ...overrides,
  };
}

describe("Accuracy Assistant — Risk Factors", () => {
  describe("self_employment_income", () => {
    const factor = getFactor("self_employment_income");

    it("returns 0 when no self-employment income", () => {
      const intake = buildIntake({
        incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1500 }],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });

    it("scores self-employment income as base risk", () => {
      const intake = buildIntake({
        incomeSources: [
          {
            incomeType: "SELF_EMPLOYMENT",
            grossAmountPerPeriod: 3000,
            selfEmploymentGross: 3000,
            selfEmploymentExpenses: 500,
          },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBeGreaterThan(0);
      expect(result.detail).toContain("Self-employment");
    });

    it("scores higher when business expenses exceed 60% of gross", () => {
      const intake = buildIntake({
        incomeSources: [
          {
            incomeType: "SELF_EMPLOYMENT",
            grossAmountPerPeriod: 3000,
            selfEmploymentGross: 3000,
            selfEmploymentExpenses: 2100, // 70% of gross
          },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(15);
      expect(result.detail).toContain("70%");
    });

    it("scores higher for itemized deduction method", () => {
      const intake = buildIntake({
        incomeSources: [
          {
            incomeType: "SELF_EMPLOYMENT",
            grossAmountPerPeriod: 3000,
            selfEmploymentGross: 3000,
            selfEmploymentExpenses: 500,
            selfEmploymentDeductionMethod: "ITEMIZED",
          },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBeGreaterThanOrEqual(12);
    });
  });

  describe("pay_frequency_risk", () => {
    const factor = getFactor("pay_frequency_risk");

    it("returns 0 when no suspicious monthly amounts", () => {
      const intake = buildIntake({
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 800 },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });

    it("flags monthly amounts in the common biweekly range", () => {
      const intake = buildIntake({
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1200 },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(12);
      expect(result.detail).toContain("biweekly");
    });

    it("does not flag monthly amounts above biweekly range", () => {
      const intake = buildIntake({
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 3000 },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });
  });

  describe("multiple_adults_no_income", () => {
    const factor = getFactor("multiple_adults_no_income");

    it("returns 0 when all adults have income", () => {
      const intake = buildIntake({
        householdMembers: [
          { inSnapHousehold: true, ageRange: "30-39", hasEarnedIncome: true, hasUnearnedIncome: false },
        ],
        incomeSources: [],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });

    it("flags 2+ working-age adults with no income", () => {
      const intake = buildIntake({
        householdMembers: [
          { id: "m1", inSnapHousehold: true, ageRange: "30-39", hasEarnedIncome: false, hasUnearnedIncome: false },
          { id: "m2", inSnapHousehold: true, ageRange: "25-29", hasEarnedIncome: false, hasUnearnedIncome: false },
        ],
        incomeSources: [],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(18);
      expect(result.detail).toContain("2 working-age adults");
    });

    it("ignores minors", () => {
      const intake = buildIntake({
        householdMembers: [
          { id: "m1", inSnapHousehold: true, ageRange: "30-39", hasEarnedIncome: false, hasUnearnedIncome: false },
          { id: "m2", inSnapHousehold: true, ageRange: "0-17", hasEarnedIncome: false, hasUnearnedIncome: false },
        ],
        incomeSources: [],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });
  });

  describe("zero_income_with_shelter", () => {
    const factor = getFactor("zero_income_with_shelter");

    it("flags $0 income with rent payments", () => {
      const intake = buildIntake({
        shelterExpense: { rentOrMortgage: 800 },
      });
      const calc = buildCalc({ deductions: { grossIncome: 0 } });
      const result = factor.evaluate(intake, calc);
      expect(result.score).toBe(16);
    });

    it("returns 0 when income exists", () => {
      const intake = buildIntake({
        shelterExpense: { rentOrMortgage: 800 },
      });
      const calc = buildCalc({ deductions: { grossIncome: 1500 } });
      const result = factor.evaluate(intake, calc);
      expect(result.score).toBe(0);
    });
  });

  describe("large_household", () => {
    const factor = getFactor("large_household");

    it("returns 0 for small households (1-3)", () => {
      const intake = buildIntake({
        householdMembers: [
          { inSnapHousehold: true },
          { inSnapHousehold: true },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0); // 2 members + 1 applicant = 3
    });

    it("scores increasing risk for larger households", () => {
      const intake = buildIntake({
        householdMembers: [
          { inSnapHousehold: true },
          { inSnapHousehold: true },
          { inSnapHousehold: true },
          { inSnapHousehold: true },
          { inSnapHousehold: true },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBeGreaterThan(0); // 5 members + 1 applicant = 6
      expect(result.detail).toContain("Household size 6");
    });
  });

  describe("income_expense_mismatch", () => {
    const factor = getFactor("income_expense_mismatch");

    it("flags when shelter exceeds 80% of gross income", () => {
      const intake = buildIntake({
        shelterExpense: { totalShelterCost: 2000 },
      });
      const calc = buildCalc({ deductions: { grossIncome: 2000 } });
      const result = factor.evaluate(intake, calc);
      expect(result.score).toBe(14);
    });

    it("returns 0 when shelter is reasonable", () => {
      const intake = buildIntake({
        shelterExpense: { totalShelterCost: 800 },
      });
      const calc = buildCalc({ deductions: { grossIncome: 3000 } });
      const result = factor.evaluate(intake, calc);
      expect(result.score).toBe(0);
    });
  });

  describe("deduction_eligibility_concern", () => {
    const factor = getFactor("deduction_eligibility_concern");

    it("flags dependent care with no earned income", () => {
      const intake = buildIntake({
        dependentCareExpense: 500,
        incomeSources: [{ incomeType: "SSI", grossAmountPerPeriod: 800 }],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBeGreaterThan(0);
      expect(result.detail).toContain("Dependent care");
    });

    it("flags medical expenses without elderly/disabled member", () => {
      const intake = buildIntake({
        medicalExpenses: 200,
        householdMembers: [
          { isElderly: false, isDisabled: false },
        ],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBeGreaterThan(0);
      expect(result.detail).toContain("Medical expenses");
    });

    it("returns 0 when deduction conditions are met", () => {
      const intake = buildIntake({
        dependentCareExpense: 500,
        medicalExpenses: 200,
        householdMembers: [{ isElderly: true, isDisabled: false }],
        incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1500 }],
      });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });
  });

  describe("consistency_flag_severity", () => {
    const factor = getFactor("consistency_flag_severity");

    it("returns 0 with no flags", () => {
      const intake = buildIntake({ consistencyFlags: [] });
      const result = factor.evaluate(intake);
      expect(result.score).toBe(0);
    });

    it("scores based on HIGH and MEDIUM flag counts", () => {
      const intake = buildIntake({
        consistencyFlags: [
          { severity: "HIGH", type: "A" },
          { severity: "HIGH", type: "B" },
          { severity: "MEDIUM", type: "C" },
        ],
      });
      const result = factor.evaluate(intake);
      // 2 HIGH * 4 + 1 MEDIUM * 2 = 10
      expect(result.score).toBe(10);
    });

    it("caps at max score", () => {
      const intake = buildIntake({
        consistencyFlags: [
          { severity: "HIGH", type: "A" },
          { severity: "HIGH", type: "B" },
          { severity: "HIGH", type: "C" },
          { severity: "MEDIUM", type: "D" },
          { severity: "MEDIUM", type: "E" },
        ],
      });
      const result = factor.evaluate(intake);
      // 3*4 + 2*2 = 16, capped at 10
      expect(result.score).toBe(10);
    });
  });
});

describe("Accuracy Assistant — Predictive Scoring", () => {
  it("calculates a low score for a clean case", async () => {
    const intake = buildIntake({
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 800 },
      ],
      householdMembers: [
        { inSnapHousehold: true, ageRange: "30-39", hasEarnedIncome: true, hasUnearnedIncome: false },
      ],
    });
    const calc = buildCalc();

    const result = await calculatePredictiveScore(intake, calc, "GA");
    expect(result.predictiveScore).toBeLessThan(MEDIUM_RISK_THRESHOLD);
    expect(result.riskLevel).toBe("LOW");
    expect(result.requiresReview).toBe(false);
  });

  it("calculates a high score for a risky case", async () => {
    const intake = buildIntake({
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          payFrequency: "MONTHLY",
          grossAmountPerPeriod: 2000,
          selfEmploymentGross: 2000,
          selfEmploymentExpenses: 1500, // 75%
          selfEmploymentDeductionMethod: "ITEMIZED",
        },
      ],
      householdMembers: [
        { id: "m1", inSnapHousehold: true, ageRange: "30-39", hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "m2", inSnapHousehold: true, ageRange: "25-29", hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      shelterExpense: { totalShelterCost: 1800, rentOrMortgage: 1200 },
      dependentCareExpense: 400,
      medicalExpenses: 500,
      consistencyFlags: [
        { severity: "HIGH", type: "TEST1" },
        { severity: "HIGH", type: "TEST2" },
        { severity: "MEDIUM", type: "TEST3" },
      ],
    });
    const calc = buildCalc({
      deductions: { grossIncome: 500, netIncome: 200, householdSize: 3 },
    });

    const result = await calculatePredictiveScore(intake, calc, "GA");
    expect(result.predictiveScore).toBeGreaterThanOrEqual(HIGH_RISK_THRESHOLD);
    expect(result.riskLevel).toBe("HIGH");
    expect(result.requiresReview).toBe(true);
    expect(result.factors.length).toBeGreaterThan(3);
  });

  it("clamps predictive score between 0 and 100", async () => {
    const intake = buildIntake({
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          payFrequency: "MONTHLY",
          grossAmountPerPeriod: 1000,
          selfEmploymentGross: 1000,
          selfEmploymentExpenses: 900,
          selfEmploymentDeductionMethod: "ITEMIZED",
        },
      ],
      householdMembers: Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        inSnapHousehold: true,
        ageRange: "30-39",
        hasEarnedIncome: false,
        hasUnearnedIncome: false,
        isElderly: false,
        isDisabled: false,
      })),
      shelterExpense: { totalShelterCost: 3000, rentOrMortgage: 2000 },
      dependentCareExpense: 800,
      medicalExpenses: 600,
      consistencyFlags: Array.from({ length: 5 }, (_, i) => ({
        severity: "HIGH",
        type: `FLAG${i}`,
      })),
    });
    const calc = buildCalc({
      deductions: { grossIncome: 0, netIncome: 0, householdSize: 7 },
    });

    const result = await calculatePredictiveScore(intake, calc, "GA");
    expect(result.predictiveScore).toBeLessThanOrEqual(100);
    expect(result.predictiveScore).toBeGreaterThanOrEqual(0);
  });
});

describe("Accuracy Assistant — Risk Summary", () => {
  it("formats HIGH risk summary with mandatory review language", () => {
    const prediction = {
      predictiveScore: 82,
      riskLevel: "HIGH",
      requiresReview: true,
      factors: [
        { name: "self_employment_income", score: 15, detail: "Self-employment detected" },
        { name: "multiple_adults_no_income", score: 18, detail: "2 adults no income" },
        { name: "consistency_flag_severity", score: 10, detail: "2 HIGH flags" },
      ],
    };
    const summary = formatRiskSummary(prediction);
    expect(summary.level).toBe("HIGH");
    expect(summary.requiresReview).toBe(true);
    expect(summary.summary).toContain("mandatory review");
    expect(summary.topRiskFactors).toHaveLength(3);
  });

  it("formats LOW risk summary with standard processing language", () => {
    const prediction = {
      predictiveScore: 12,
      riskLevel: "LOW",
      requiresReview: false,
      factors: [
        { name: "large_household", score: 4, detail: "Household size 5" },
      ],
    };
    const summary = formatRiskSummary(prediction);
    expect(summary.level).toBe("LOW");
    expect(summary.requiresReview).toBe(false);
    expect(summary.summary).toContain("standard processing");
  });

  it("formats MEDIUM risk summary with review recommended language", () => {
    const prediction = {
      predictiveScore: 55,
      riskLevel: "MEDIUM",
      requiresReview: false,
      factors: [
        { name: "pay_frequency_risk", score: 12, detail: "Suspicious monthly amount" },
        { name: "large_household", score: 6, detail: "Household size 6" },
      ],
    };
    const summary = formatRiskSummary(prediction);
    expect(summary.level).toBe("MEDIUM");
    expect(summary.summary).toContain("review recommended");
  });
});

describe("Accuracy Assistant — Thresholds", () => {
  it("HIGH_RISK_THRESHOLD is 70", () => {
    expect(HIGH_RISK_THRESHOLD).toBe(70);
  });

  it("MEDIUM_RISK_THRESHOLD is 40", () => {
    expect(MEDIUM_RISK_THRESHOLD).toBe(40);
  });

  it("RISK_FACTORS has expected count", () => {
    expect(RISK_FACTORS.length).toBe(9);
  });

  it("all risk factors have required properties", () => {
    for (const factor of RISK_FACTORS) {
      expect(factor).toHaveProperty("name");
      expect(factor).toHaveProperty("description");
      expect(factor).toHaveProperty("baseWeight");
      expect(typeof factor.evaluate).toBe("function");
      expect(factor.baseWeight).toBeGreaterThan(0);
    }
  });
});
