import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * SNAP Calculator Accuracy Tests
 *
 * Tests the full deduction pipeline, eligibility tests, and benefit estimation
 * with mocked database calls. Verifies federal methodology compliance.
 */

const require_ = setupPrismaMock(import.meta.url);

const gaConfig = require_("../src/config/ga-snap-deductions-fy2026.json");

const {
  calculateDeductions,
  checkGrossIncomeTest,
  checkNetIncomeTest,
  calculateBenefitEstimate,
  getSnapLimits,
  calculateMonthlyIncome,
} = require_("../src/services/snapCalculator");

describe("SNAP Calculator Accuracy", () => {
  describe("getSnapLimits", () => {
    it("returns correct limits for HH size 3", async () => {
      const limits = await getSnapLimits(2026, 3);
      expect(limits.grossIncomeLimit).toBe(2764);
      expect(limits.netIncomeLimit).toBe(2127);
      expect(limits.maxAllotment).toBe(768);
      expect(limits.standardDeduction).toBe(209);
    });
  });

  describe("calculateDeductions — single employed applicant", () => {
    it("correctly applies standard + earned income deductions for HH1", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1200 },
        ],
      };

      const result = await calculateDeductions(intake, 2026);

      expect(result.householdSize).toBe(1);
      expect(result.grossIncome).toBe(1200);

      // Standard deduction for HH1: $209
      const stdDed = result.deductions.find((d) => d.type === "STANDARD");
      expect(stdDed.amount).toBe(209);

      // 20% earned income: $1200 × 0.20 = $240
      const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
      expect(earnedDed.amount).toBe(240);

      // Total deductions: 209 + 240 = 449
      expect(result.totalDeductions).toBeGreaterThanOrEqual(449);
      // Net: 1200 - 449 = 751
      expect(result.netIncome).toBe(751);
    });
  });

  describe("calculateDeductions — household with shelter", () => {
    it("calculates shelter excess deduction correctly (non-elderly, capped at $744)", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: false, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
        ],
        shelterExpense: {
          rentOrMortgage: 1200,
          propertyTax: 0,
          homeownersInsurance: 0,
          standardUtilityAllowance: 414,
        },
      };

      const result = await calculateDeductions(intake, 2026);

      // HH2 (applicant + 1 member)
      expect(result.householdSize).toBe(2);
      expect(result.grossIncome).toBe(2000);

      // Standard: $209, Earned: 2000 * 0.20 = $400
      // Pre-shelter deductions: 209 + 400 = 609
      // Remaining: 2000 - 609 = 1391
      // Total shelter: 1200 + 414 = 1614
      // Excess: 1614 - (1391 * 0.5) = 1614 - 695.5 = 918.5
      // Capped at $744 (no elderly/disabled)
      const shelterDed = result.deductions.find((d) => d.type === "SHELTER_EXCESS");
      expect(shelterDed).toBeDefined();
      expect(shelterDed.amount).toBe(744);

      // Total: 209 + 400 + 744 = 1353
      expect(result.totalDeductions).toBeCloseTo(1353, 0);
      // Net: 2000 - 1353 = 647
      expect(result.netIncome).toBeCloseTo(647, 0);
    });

    it("shelter deduction uncapped for elderly/disabled household", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: true, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 1500 },
        ],
        shelterExpense: {
          rentOrMortgage: 1200,
          propertyTax: 100,
          homeownersInsurance: 50,
          standardUtilityAllowance: 414,
        },
      };

      const result = await calculateDeductions(intake, 2026);

      expect(result.hasElderlyOrDisabled).toBe(true);

      // No earned income deduction (Social Security is unearned)
      const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
      expect(earnedDed).toBeUndefined();

      // Remaining: 1500 - 209 = 1291
      // Total shelter: 1200 + 100 + 50 + 414 = 1764
      // Excess: 1764 - (1291 * 0.5) = 1764 - 645.5 = 1118.5
      // Uncapped for elderly
      const shelterDed = result.deductions.find((d) => d.type === "SHELTER_EXCESS");
      expect(shelterDed).toBeDefined();
      expect(shelterDed.amount).toBeCloseTo(1118.5, 0);
      expect(shelterDed.amount).toBeGreaterThan(gaConfig.shelterDeductionCap);
    });
  });

  describe("calculateDeductions — medical expenses", () => {
    it("applies medical deduction for elderly with expenses over $35 threshold", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: true, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 900 },
        ],
        medicalExpenses: 200,
      };

      const result = await calculateDeductions(intake, 2026);

      const medDed = result.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeDefined();
      // Medical: max($161 standard, $200 - $35) = max(161, 165) = 165
      expect(medDed.amount).toBe(165);
    });

    it("uses standard medical deduction when actual is lower", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: false, isDisabled: true },
        ],
        incomeSources: [
          { incomeType: "SSDI", payFrequency: "MONTHLY", grossAmountPerPeriod: 1000 },
        ],
        medicalExpenses: 100,
      };

      const result = await calculateDeductions(intake, 2026);

      const medDed = result.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeDefined();
      // Medical: max($161, $100 - $35) = max(161, 65) = 161
      expect(medDed.amount).toBe(161);
    });

    it("does not apply medical deduction for non-elderly/disabled", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: false, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1000 },
        ],
        medicalExpenses: 200,
      };

      const result = await calculateDeductions(intake, 2026);

      const medDed = result.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeUndefined();
    });

    it("does not apply medical deduction at or below $35 threshold", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: true, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 800 },
        ],
        medicalExpenses: 35,
      };

      const result = await calculateDeductions(intake, 2026);

      const medDed = result.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeUndefined();
    });
  });

  describe("calculateDeductions — dependent care and child support", () => {
    it("includes dependent care deduction", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: false, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2500 },
        ],
        dependentCareExpense: 600,
      };

      const result = await calculateDeductions(intake, 2026);

      const careDed = result.deductions.find((d) => d.type === "DEPENDENT_CARE");
      expect(careDed).toBeDefined();
      expect(careDed.amount).toBe(600);
    });

    it("includes child support paid deduction", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
        ],
        childSupportPaid: 350,
      };

      const result = await calculateDeductions(intake, 2026);

      const csDed = result.deductions.find((d) => d.type === "CHILD_SUPPORT_PAID");
      expect(csDed).toBeDefined();
      expect(csDed.amount).toBe(350);
    });
  });

  describe("calculateDeductions — zero income household", () => {
    it("only applies standard deduction, net income is zero", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [],
      };

      const result = await calculateDeductions(intake, 2026);

      expect(result.grossIncome).toBe(0);
      expect(result.netIncome).toBe(0);
      expect(result.deductions).toHaveLength(1);
      expect(result.deductions[0].type).toBe("STANDARD");
    });
  });

  describe("checkGrossIncomeTest", () => {
    it("passes when gross income is below limit", async () => {
      const result = await checkGrossIncomeTest(2000, 3, "GA", false, 2026);
      expect(result.passes).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it("passes at exactly the limit", async () => {
      const result = await checkGrossIncomeTest(2764, 3, "GA", false, 2026);
      expect(result.passes).toBe(true);
    });

    it("fails when gross income exceeds limit", async () => {
      const result = await checkGrossIncomeTest(2765, 3, "GA", false, 2026);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain("DOES NOT PASS");
    });

    it("skips for elderly/disabled households", async () => {
      const result = await checkGrossIncomeTest(5000, 3, "GA", true, 2026);
      expect(result.passes).toBe(true);
      expect(result.skipped).toBe(true);
    });
  });

  describe("checkNetIncomeTest", () => {
    it("passes when net income is below limit", async () => {
      const result = await checkNetIncomeTest(1500, 3, 2026);
      expect(result.passes).toBe(true);
    });

    it("passes at exactly the limit", async () => {
      const result = await checkNetIncomeTest(2127, 3, 2026);
      expect(result.passes).toBe(true);
    });

    it("fails when net income exceeds limit", async () => {
      const result = await checkNetIncomeTest(2128, 3, 2026);
      expect(result.passes).toBe(false);
    });
  });

  describe("calculateBenefitEstimate", () => {
    it("calculates correct benefit for zero-income HH3", async () => {
      const result = await calculateBenefitEstimate(0, 3, 2026);
      expect(result.estimatedBenefit).toBe(768);
      expect(result.maxAllotment).toBe(768);
      expect(result.expectedContribution).toBe(0);
    });

    it("calculates correct benefit for moderate income", async () => {
      const result = await calculateBenefitEstimate(1000, 3, 2026);
      // Contribution: ceil(1000 × 0.30) = 300
      // Benefit: 768 - 300 = 468
      expect(result.expectedContribution).toBe(300);
      expect(result.estimatedBenefit).toBe(468);
    });

    it("applies minimum benefit of $24 for HH1-2 when benefit is small", async () => {
      const result = await calculateBenefitEstimate(950, 1, 2026);
      // Contribution: ceil(950 × 0.30) = ceil(285) = 285
      // Raw benefit: 292 - 285 = 7, minimum $24 applies
      expect(result.estimatedBenefit).toBe(24);
    });

    it("does not apply minimum benefit for HH3+", async () => {
      const result = await calculateBenefitEstimate(2490, 3, 2026);
      // Contribution: ceil(2490 × 0.30) = ceil(747) = 747
      // Benefit: 768 - 747 = 21, no minimum for HH3
      expect(result.estimatedBenefit).toBe(21);
    });

    it("returns zero when contribution exceeds max allotment", async () => {
      const result = await calculateBenefitEstimate(5000, 1, 2026);
      expect(result.estimatedBenefit).toBe(0);
    });
  });

  describe("Full deduction methodology — end-to-end scenarios", () => {
    it("employed single parent with child, shelter, and dependent care", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: false, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 900 },
        ],
        dependentCareExpense: 400,
        shelterExpense: {
          rentOrMortgage: 850,
          propertyTax: 0,
          homeownersInsurance: 0,
          standardUtilityAllowance: 414,
        },
      };

      const result = await calculateDeductions(intake, 2026);

      expect(result.householdSize).toBe(2);
      // Gross: 900 × 2.167 = 1950.30
      expect(result.grossIncome).toBeCloseTo(1950.3, 1);

      // Steps 1-5: 209 + 390.06 + 400 = 999.06
      // Remaining: 1950.30 - 999.06 = 951.24
      expect(result.remainingIncomeBeforeShelter).toBeCloseTo(951.24, 0);

      // Shelter excess: 1264 - 475.62 = 788.38, capped at $744
      const shelterDed = result.deductions.find((d) => d.type === "SHELTER_EXCESS");
      expect(shelterDed.amount).toBe(744);

      // Total: 999.06 + 744 = 1743.06
      expect(result.totalDeductions).toBeCloseTo(1743.06, 0);
      // Net: 1950.30 - 1743.06 = 207.24
      expect(result.netIncome).toBeCloseTo(207.24, 0);
    });

    it("elderly couple with SSI and high medical expenses", async () => {
      const intake = {
        householdMembers: [
          { inSnapHousehold: true, isElderly: true, isDisabled: false },
        ],
        incomeSources: [
          { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 914 },
          { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 800 },
        ],
        medicalExpenses: 350,
        shelterExpense: {
          rentOrMortgage: 900,
          propertyTax: 0,
          homeownersInsurance: 0,
          standardUtilityAllowance: 414,
        },
      };

      const result = await calculateDeductions(intake, 2026);

      expect(result.householdSize).toBe(2);
      expect(result.hasElderlyOrDisabled).toBe(true);
      expect(result.grossIncome).toBe(1714);

      // No earned income deduction
      const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
      expect(earnedDed).toBeUndefined();

      // Medical: max(161, 350 - 35) = 315
      const medDed = result.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed.amount).toBe(315);

      // Shelter: 1314 - 595 = 719 (uncapped)
      const shelterDed = result.deductions.find((d) => d.type === "SHELTER_EXCESS");
      expect(shelterDed.amount).toBeCloseTo(719, 0);

      // Total: 209 + 315 + 719 = 1243
      expect(result.totalDeductions).toBeCloseTo(1243, 0);
      // Net: 1714 - 1243 = 471
      expect(result.netIncome).toBeCloseTo(471, 0);
    });

    it("self-employed applicant uses standard 40% deduction", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [
          {
            incomeType: "SELF_EMPLOYMENT",
            payFrequency: "MONTHLY",
            grossAmountPerPeriod: 4000,
            selfEmploymentGross: 4000,
            selfEmploymentExpenses: 500,
          },
        ],
      };

      const result = await calculateDeductions(intake, 2026);

      // Self-emp: min(4000-500, 4000*0.6) = min(3500, 2400) = 2400
      expect(result.grossIncome).toBe(2400);

      // Earned income 20%: 2400 × 0.20 = $480
      const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
      expect(earnedDed.amount).toBe(480);
    });
  });

  describe("Income conversion accuracy", () => {
    it("weekly conversion: 4.333 weeks/month", () => {
      const result = calculateMonthlyIncome({
        incomeType: "EMPLOYMENT",
        payFrequency: "WEEKLY",
        grossAmountPerPeriod: 750,
      });
      expect(result).toBeCloseTo(3249.75, 2);
    });

    it("biweekly conversion: 2.167 factor", () => {
      const result = calculateMonthlyIncome({
        incomeType: "EMPLOYMENT",
        payFrequency: "BIWEEKLY",
        grossAmountPerPeriod: 1500,
      });
      expect(result).toBeCloseTo(3250.5, 2);
    });

    it("throws for unknown pay frequency", () => {
      expect(() =>
        calculateMonthlyIncome({
          incomeType: "EMPLOYMENT",
          payFrequency: "DAILY",
          grossAmountPerPeriod: 100,
        })
      ).toThrow("Unknown pay frequency: DAILY");
    });

    it("self-employment with zero expenses uses 40% standard deduction", () => {
      const result = calculateMonthlyIncome({
        incomeType: "SELF_EMPLOYMENT",
        grossAmountPerPeriod: 5000,
        selfEmploymentGross: 5000,
        selfEmploymentExpenses: 0,
      });
      expect(result).toBe(3000);
    });
  });
});
