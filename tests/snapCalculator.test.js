import { describe, it, expect } from "vitest";

// Import pure functions (non-DB-dependent)
const {
  calculateMonthlyIncome,
  calculateHouseholdGrossIncome,
  checkExpeditedEligibility,
  getStandardUtilityAllowance,
  FREQUENCY_MULTIPLIERS,
} = require("../src/services/snapCalculator");

describe("snapCalculator", () => {
  describe("FREQUENCY_MULTIPLIERS", () => {
    it("has correct conversion factors", () => {
      expect(FREQUENCY_MULTIPLIERS.WEEKLY).toBe(4.333);
      expect(FREQUENCY_MULTIPLIERS.BIWEEKLY).toBe(2.167);
      expect(FREQUENCY_MULTIPLIERS.SEMI_MONTHLY).toBe(2);
      expect(FREQUENCY_MULTIPLIERS.MONTHLY).toBe(1);
    });
  });

  describe("calculateMonthlyIncome", () => {
    it("converts weekly income to monthly", () => {
      const result = calculateMonthlyIncome({
        incomeType: "EMPLOYMENT",
        payFrequency: "WEEKLY",
        grossAmountPerPeriod: 500,
      });
      expect(result).toBeCloseTo(2166.5, 1);
    });

    it("converts biweekly income to monthly", () => {
      const result = calculateMonthlyIncome({
        incomeType: "EMPLOYMENT",
        payFrequency: "BIWEEKLY",
        grossAmountPerPeriod: 1147.5,
      });
      expect(result).toBeCloseTo(2486.62, 1);
    });

    it("converts semi-monthly income to monthly", () => {
      const result = calculateMonthlyIncome({
        incomeType: "EMPLOYMENT",
        payFrequency: "SEMI_MONTHLY",
        grossAmountPerPeriod: 1200,
      });
      expect(result).toBe(2400);
    });

    it("monthly income stays the same", () => {
      const result = calculateMonthlyIncome({
        incomeType: "SOCIAL_SECURITY",
        payFrequency: "MONTHLY",
        grossAmountPerPeriod: 892,
      });
      expect(result).toBe(892);
    });

    it("handles self-employment with itemized deduction", () => {
      // Gross $3000, expenses $1500 → itemized net $1500, standard net $1800
      // Should use itemized (lower) = $1500
      const result = calculateMonthlyIncome({
        incomeType: "SELF_EMPLOYMENT",
        payFrequency: "MONTHLY",
        grossAmountPerPeriod: 3000,
        selfEmploymentGross: 3000,
        selfEmploymentExpenses: 1500,
      });
      expect(result).toBe(1500);
    });

    it("handles self-employment with standard deduction (lower)", () => {
      // Gross $3000, expenses $200 → itemized net $2800, standard net $1800
      // Should use standard (lower) = $1800
      const result = calculateMonthlyIncome({
        incomeType: "SELF_EMPLOYMENT",
        payFrequency: "MONTHLY",
        grossAmountPerPeriod: 3000,
        selfEmploymentGross: 3000,
        selfEmploymentExpenses: 200,
      });
      expect(result).toBe(1800);
    });

    it("self-employment net cannot be negative", () => {
      const result = calculateMonthlyIncome({
        incomeType: "SELF_EMPLOYMENT",
        payFrequency: "MONTHLY",
        grossAmountPerPeriod: 100,
        selfEmploymentGross: 100,
        selfEmploymentExpenses: 500,
      });
      expect(result).toBe(0);
    });
  });

  describe("calculateHouseholdGrossIncome", () => {
    it("sums multiple income sources", () => {
      const sources = [
        { snapMonthlyAmount: 2485.15 },
        { snapMonthlyAmount: 892.0 },
      ];
      expect(calculateHouseholdGrossIncome(sources)).toBeCloseTo(3377.15, 2);
    });

    it("falls back to calculateMonthlyIncome when snapMonthlyAmount is null", () => {
      const sources = [
        {
          incomeType: "EMPLOYMENT",
          payFrequency: "MONTHLY",
          grossAmountPerPeriod: 2000,
          snapMonthlyAmount: null,
        },
      ];
      expect(calculateHouseholdGrossIncome(sources)).toBe(2000);
    });

    it("returns 0 for empty array", () => {
      expect(calculateHouseholdGrossIncome([])).toBe(0);
    });
  });

  describe("checkExpeditedEligibility", () => {
    it("qualifies when gross < $150 and resources < $100", () => {
      const result = checkExpeditedEligibility(100, 50, 800, 414);
      expect(result.eligible).toBe(true);
      expect(result.reasons).toContain("Gross monthly income < $150 and liquid resources < $100");
    });

    it("qualifies when income + resources < rent + utilities", () => {
      const result = checkExpeditedEligibility(500, 100, 800, 414);
      // 500 + 100 = 600 < 800 + 414 = 1214
      expect(result.eligible).toBe(true);
    });

    it("does not qualify when neither condition met", () => {
      const result = checkExpeditedEligibility(2000, 500, 800, 414);
      // 2000 + 500 = 2500 > 1214; 2000 > 150
      expect(result.eligible).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });

    it("can qualify on both conditions simultaneously", () => {
      const result = checkExpeditedEligibility(100, 50, 800, 414);
      expect(result.eligible).toBe(true);
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getStandardUtilityAllowance", () => {
    it("returns correct GA FY2026 SUA for HEATING_COOLING", () => {
      expect(getStandardUtilityAllowance("HEATING_COOLING")).toBe(414);
    });

    it("returns correct SUA for BASIC", () => {
      expect(getStandardUtilityAllowance("BASIC")).toBe(284);
    });

    it("returns correct SUA for PHONE_ONLY", () => {
      expect(getStandardUtilityAllowance("PHONE_ONLY")).toBe(55);
    });

    it("returns 0 for NONE", () => {
      expect(getStandardUtilityAllowance("NONE")).toBe(0);
    });

    it("returns 0 for unknown type", () => {
      expect(getStandardUtilityAllowance("INVALID")).toBe(0);
    });
  });
});
