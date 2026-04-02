import { describe, it, expect } from "vitest";
import { setupPrismaMock, FY2026_DATA } from "./helpers/mockPrisma.js";

/**
 * SNAP Calculator — Compute-Heavy Scenario Tests
 *
 * Covers gaps in the existing test suite:
 * - Large household extrapolation (HH 9–15)
 * - Full eligibility pipeline (calculateFullEligibility)
 * - Multi-income source households
 * - All 6 deduction types stacked simultaneously
 * - Expedited eligibility boundary conditions
 * - Self-employment itemized vs standard crossover
 * - Rounding and penny-level accuracy
 */

const require_ = setupPrismaMock(import.meta.url);

const gaConfig = require_("../src/config/ga-snap-deductions-fy2026.json");

const {
  calculateDeductions,
  checkGrossIncomeTest,
  checkNetIncomeTest,
  calculateBenefitEstimate,
  checkExpeditedEligibility,
  calculateFullEligibility,
  getSnapLimits,
  calculateMonthlyIncome,
  getStandardUtilityAllowance,
  FREQUENCY_MULTIPLIERS,
} = require_("../src/services/snapCalculator");

// ─── Large Household Extrapolation ─────────────────────────────────────────

describe("Large household extrapolation (HH 9–15)", () => {
  const hh8 = FY2026_DATA[8];
  const incPerGross = gaConfig.additionalMemberGrossIncomeIncrement;
  const incPerNet = gaConfig.additionalMemberNetIncomeIncrement;
  const incPerAllot = gaConfig.additionalMemberAllotmentIncrement;

  it.each([9, 10, 12, 15])("extrapolates limits correctly for HH size %i", async (size) => {
    const extra = size - 8;
    const limits = await getSnapLimits(2026, size);

    expect(limits.grossIncomeLimit).toBe(hh8.grossIncomeLimit + extra * incPerGross);
    expect(limits.netIncomeLimit).toBe(hh8.netIncomeLimit + extra * incPerNet);
    expect(limits.maxAllotment).toBe(hh8.maxAllotment + extra * incPerAllot);
    // Standard deduction stays at HH8 level (capped)
    expect(limits.standardDeduction).toBe(hh8.standardDeduction);
  });

  it("HH9 benefit estimate uses extrapolated max allotment", async () => {
    const expectedMax = hh8.maxAllotment + incPerAllot; // 1756 + 220 = 1976
    const result = await calculateBenefitEstimate(0, 9, 2026);
    expect(result.maxAllotment).toBe(expectedMax);
    expect(result.estimatedBenefit).toBe(expectedMax);
  });

  it("HH10 gross income test uses extrapolated limit", async () => {
    const expectedLimit = hh8.grossIncomeLimit + 2 * incPerGross; // 5594 + 1132 = 6726
    const result = await checkGrossIncomeTest(6726, 10, "GA", false, 2026);
    expect(result.passes).toBe(true);
    expect(result.limit).toBe(expectedLimit);

    const fail = await checkGrossIncomeTest(6727, 10, "GA", false, 2026);
    expect(fail.passes).toBe(false);
  });

  it("HH15 deductions use correct household size and standard deduction", async () => {
    const intake = {
      householdMembers: Array.from({ length: 14 }, () => ({
        inSnapHousehold: true,
        isElderly: false,
        isDisabled: false,
      })),
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 5000 },
      ],
    };

    const result = await calculateDeductions(intake, 2026);
    expect(result.householdSize).toBe(15);
    expect(result.deductions.find((d) => d.type === "STANDARD").amount).toBe(hh8.standardDeduction);
  });
});

// ─── calculateFullEligibility End-to-End ───────────────────────────────────

describe("calculateFullEligibility — end-to-end pipeline", () => {
  it("zero-income single applicant gets max benefit and expedited", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [],
      liquidResources: 0,
      shelterExpense: {
        rentOrMortgage: 600,
        propertyTax: 0,
        homeownersInsurance: 0,
        standardUtilityAllowance: 414,
      },
    };

    const result = await calculateFullEligibility(intake, "GA", 2026);

    expect(result.eligible).toBe(true);
    expect(result.grossIncomeTest.passes).toBe(true);
    expect(result.netIncomeTest.passes).toBe(true);
    expect(result.deductions.grossIncome).toBe(0);
    expect(result.deductions.netIncome).toBe(0);
    expect(result.benefitEstimate.estimatedBenefit).toBe(292); // max for HH1
    expect(result.expedited.eligible).toBe(true);
  });

  it("moderate-income HH3 is eligible with partial benefit", async () => {
    const intake = {
      householdMembers: [
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 900 },
      ],
      shelterExpense: {
        rentOrMortgage: 800,
        propertyTax: 0,
        homeownersInsurance: 0,
        standardUtilityAllowance: 284,
      },
    };

    const result = await calculateFullEligibility(intake, "GA", 2026);

    expect(result.eligible).toBe(true);
    expect(result.deductions.householdSize).toBe(3);
    expect(result.benefitEstimate.estimatedBenefit).toBeGreaterThan(0);
    expect(result.expedited.eligible).toBe(false);
  });

  it("high-income household fails gross income test", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
      ],
    };

    const result = await calculateFullEligibility(intake, "GA", 2026);

    // HH1 gross limit = 1632, income = 2000
    expect(result.eligible).toBe(false);
    expect(result.grossIncomeTest.passes).toBe(false);
  });

  it("elderly household skips gross test but must pass net test", async () => {
    const intake = {
      householdMembers: [
        { inSnapHousehold: true, isElderly: true, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 3000 },
      ],
      medicalExpenses: 400,
      shelterExpense: {
        rentOrMortgage: 1000,
        propertyTax: 150,
        homeownersInsurance: 80,
        standardUtilityAllowance: 414,
      },
    };

    const result = await calculateFullEligibility(intake, "GA", 2026);

    expect(result.grossIncomeTest.passes).toBe(true);
    expect(result.grossIncomeTest.skipped).toBe(true);
    // Verify net test is still evaluated
    expect(result.netIncomeTest).toHaveProperty("passes");
  });

  it("result structure includes all expected keys", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [],
      liquidResources: 50,
      shelterExpense: { rentOrMortgage: 0 },
    };

    const result = await calculateFullEligibility(intake, "GA", 2026);

    expect(result).toHaveProperty("eligible");
    expect(result).toHaveProperty("grossIncomeTest");
    expect(result).toHaveProperty("netIncomeTest");
    expect(result).toHaveProperty("deductions");
    expect(result).toHaveProperty("benefitEstimate");
    expect(result).toHaveProperty("expedited");
    expect(result.deductions).toHaveProperty("grossIncome");
    expect(result.deductions).toHaveProperty("netIncome");
    expect(result.deductions).toHaveProperty("totalDeductions");
    expect(result.deductions).toHaveProperty("deductions");
    expect(result.benefitEstimate).toHaveProperty("estimatedBenefit");
    expect(result.benefitEstimate).toHaveProperty("maxAllotment");
  });
});

// ─── Multi-Income Source Households ────────────────────────────────────────

describe("Multi-income source households", () => {
  it("employment + self-employment + SSI combined correctly", async () => {
    const intake = {
      householdMembers: [
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 400 },
        {
          incomeType: "SELF_EMPLOYMENT",
          payFrequency: "MONTHLY",
          grossAmountPerPeriod: 3000,
          selfEmploymentGross: 3000,
          selfEmploymentExpenses: 800,
        },
        { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 914 },
      ],
    };

    const result = await calculateDeductions(intake, 2026);

    // Employment: 400 × 4.333 = 1733.20
    const empMonthly = Math.round(400 * 4.333 * 100) / 100;
    // Self-emp: min(3000-800, 3000*0.6) = min(2200, 1800) = 1800
    const selfEmpMonthly = 1800;
    // SSI: 914
    const ssiMonthly = 914;

    expect(result.grossIncome).toBeCloseTo(empMonthly + selfEmpMonthly + ssiMonthly, 1);

    // Earned income = employment + self-employment
    const totalEarned = empMonthly + selfEmpMonthly;
    const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
    expect(earnedDed.amount).toBeCloseTo(totalEarned * 0.20, 1);
  });

  it("multiple employment sources at different frequencies", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 200 },
        { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 600 },
        { incomeType: "EMPLOYMENT", payFrequency: "SEMI_MONTHLY", grossAmountPerPeriod: 500 },
      ],
    };

    const result = await calculateDeductions(intake, 2026);

    const expected =
      Math.round(200 * 4.333 * 100) / 100 +
      Math.round(600 * 2.167 * 100) / 100 +
      Math.round(500 * 2 * 100) / 100;

    expect(result.grossIncome).toBeCloseTo(expected, 1);
  });

  it("unearned-only household gets no earned income deduction", async () => {
    const intake = {
      householdMembers: [
        { inSnapHousehold: true, isElderly: true, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 914 },
        { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 600 },
        { incomeType: "VA_BENEFITS", payFrequency: "MONTHLY", grossAmountPerPeriod: 200 },
      ],
    };

    const result = await calculateDeductions(intake, 2026);

    expect(result.grossIncome).toBe(1714);
    const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
    expect(earnedDed).toBeUndefined();
  });
});

// ─── All 6 Deduction Types Stacked ────────────────────────────────────────

describe("All 6 deduction types applied simultaneously", () => {
  it("kitchen-sink scenario: standard + earned + dependent care + medical + child support + shelter", async () => {
    const intake = {
      householdMembers: [
        { inSnapHousehold: true, isElderly: true, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2500 },
        { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 800 },
      ],
      dependentCareExpense: 450,
      medicalExpenses: 250,
      childSupportPaid: 300,
      shelterExpense: {
        rentOrMortgage: 1100,
        propertyTax: 200,
        homeownersInsurance: 100,
        standardUtilityAllowance: 414,
      },
    };

    const result = await calculateDeductions(intake, 2026);

    expect(result.householdSize).toBe(3);
    expect(result.hasElderlyOrDisabled).toBe(true);
    expect(result.grossIncome).toBe(3300);

    // Verify all 6 deduction types present
    const types = result.deductions.map((d) => d.type);
    expect(types).toContain("STANDARD");
    expect(types).toContain("EARNED_INCOME_20PCT");
    expect(types).toContain("DEPENDENT_CARE");
    expect(types).toContain("MEDICAL");
    expect(types).toContain("CHILD_SUPPORT_PAID");
    expect(types).toContain("SHELTER_EXCESS");
    expect(result.deductions).toHaveLength(6);

    // Step-by-step verification
    const stdDed = result.deductions.find((d) => d.type === "STANDARD");
    expect(stdDed.amount).toBe(209); // HH3

    const earnedDed = result.deductions.find((d) => d.type === "EARNED_INCOME_20PCT");
    expect(earnedDed.amount).toBe(500); // 2500 * 0.20

    const careDed = result.deductions.find((d) => d.type === "DEPENDENT_CARE");
    expect(careDed.amount).toBe(450);

    // Medical: max(161, 250-35) = max(161, 215) = 215
    const medDed = result.deductions.find((d) => d.type === "MEDICAL");
    expect(medDed.amount).toBe(215);

    const csDed = result.deductions.find((d) => d.type === "CHILD_SUPPORT_PAID");
    expect(csDed.amount).toBe(300);

    // Pre-shelter: 209 + 500 + 450 + 215 + 300 = 1674
    // Remaining: 3300 - 1674 = 1626
    expect(result.remainingIncomeBeforeShelter).toBeCloseTo(1626, 0);

    // Shelter: 1814 - (1626 * 0.5) = 1814 - 813 = 1001 (uncapped, elderly)
    const shelterDed = result.deductions.find((d) => d.type === "SHELTER_EXCESS");
    expect(shelterDed.amount).toBeCloseTo(1001, 0);

    // Total: 1674 + 1001 = 2675
    expect(result.totalDeductions).toBeCloseTo(2675, 0);
    // Net: 3300 - 2675 = 625
    expect(result.netIncome).toBeCloseTo(625, 0);
  });
});

// ─── Expedited Eligibility Boundary Conditions ─────────────────────────────

describe("Expedited eligibility boundary conditions", () => {
  it("condition 1: exactly $150 gross and $100 resources — NOT eligible", () => {
    const result = checkExpeditedEligibility(150, 100, 500, 200);
    // < 150 and < 100 required — at exactly 150/100, fails condition 1
    const hasCond1 = result.reasons.some((r) => r.includes("< $150"));
    expect(hasCond1).toBe(false);
  });

  it("condition 1: $149.99 gross and $99 resources — eligible", () => {
    const result = checkExpeditedEligibility(149.99, 99, 500, 200);
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.includes("< $150"))).toBe(true);
  });

  it("condition 2: combined exactly equals shelter — NOT eligible", () => {
    // combined (200 + 100 = 300) = shelter (200 + 100 = 300)
    const result = checkExpeditedEligibility(200, 100, 200, 100);
    const hasCond2 = result.reasons.some((r) => r.includes("Combined"));
    expect(hasCond2).toBe(false);
  });

  it("condition 2: combined $1 less than shelter — eligible", () => {
    const result = checkExpeditedEligibility(200, 99, 200, 100);
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.includes("Combined"))).toBe(true);
  });

  it("both conditions met simultaneously", () => {
    const result = checkExpeditedEligibility(100, 50, 500, 300);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });

  it("neither condition met", () => {
    const result = checkExpeditedEligibility(2000, 5000, 800, 200);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("zero income and zero resources with any shelter qualifies via both conditions", () => {
    const result = checkExpeditedEligibility(0, 0, 100, 50);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });

  it("zero shelter costs — condition 2 fails (0 < 0 is false)", () => {
    const result = checkExpeditedEligibility(200, 100, 0, 0);
    const hasCond2 = result.reasons.some((r) => r.includes("Combined"));
    expect(hasCond2).toBe(false);
  });
});

// ─── Self-Employment Crossover ─────────────────────────────────────────────

describe("Self-employment: itemized vs standard deduction crossover", () => {
  it("low expenses → standard 40% deduction is more favorable", () => {
    // Gross $5000, expenses $500
    // Itemized net: 5000 - 500 = 4500
    // Standard net: 5000 * 0.6 = 3000
    // min(4500, 3000) = 3000 (standard wins)
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 5000,
      selfEmploymentExpenses: 500,
    });
    expect(result).toBe(3000);
  });

  it("high expenses → itemized deduction is more favorable", () => {
    // Gross $5000, expenses $2500
    // Itemized net: 5000 - 2500 = 2500
    // Standard net: 5000 * 0.6 = 3000
    // min(2500, 3000) = 2500 (itemized wins)
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 5000,
      selfEmploymentExpenses: 2500,
    });
    expect(result).toBe(2500);
  });

  it("exact crossover: expenses = 40% of gross → both methods equal", () => {
    // Gross $5000, expenses $2000
    // Itemized: 5000 - 2000 = 3000
    // Standard: 5000 * 0.6 = 3000
    // min(3000, 3000) = 3000
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 5000,
      selfEmploymentExpenses: 2000,
    });
    expect(result).toBe(3000);
  });

  it("expenses exceed gross → countable income floors at $0", () => {
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 1000,
      selfEmploymentExpenses: 1500,
    });
    // Itemized: 1000 - 1500 = -500 → min(-500, 600) = -500 → max(0, -500) = 0
    expect(result).toBe(0);
  });

  it("very high gross with proportional expenses", () => {
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 50000,
      selfEmploymentExpenses: 25000,
    });
    // Itemized: 25000, Standard: 30000 → min = 25000
    expect(result).toBe(25000);
  });
});

// ─── Benefit Calculation Edge Cases ────────────────────────────────────────

describe("Benefit calculation edge cases", () => {
  it("minimum benefit applies for HH1 with tiny positive benefit", async () => {
    // Find net income where raw benefit is between $1 and $23
    // maxAllotment HH1 = 292, contribution = ceil(net * 0.30)
    // benefit = 292 - contribution > 0 and < 24
    // 292 - ceil(net * 0.30) = 1 → ceil(net * 0.30) = 291 → net ≈ 970
    const result = await calculateBenefitEstimate(970, 1, 2026);
    // ceil(970 * 0.30) = ceil(291) = 291, benefit = 292 - 291 = 1, min $24
    expect(result.estimatedBenefit).toBe(24);
  });

  it("minimum benefit applies for HH2 the same way", async () => {
    // maxAllotment HH2 = 536
    // benefit = 536 - ceil(net * 0.30)
    // For benefit = 10: ceil(net * 0.30) = 526, net ≈ 1753.33
    const result = await calculateBenefitEstimate(1753, 2, 2026);
    // ceil(1753 * 0.30) = ceil(525.9) = 526, benefit = 536 - 526 = 10, min $24
    expect(result.estimatedBenefit).toBe(24);
  });

  it("minimum benefit does NOT apply for HH3", async () => {
    // maxAllotment HH3 = 768
    // ceil(2550 * 0.30) = ceil(765) = 765, benefit = 768 - 765 = 3
    const result = await calculateBenefitEstimate(2550, 3, 2026);
    expect(result.estimatedBenefit).toBe(3);
    expect(result.estimatedBenefit).toBeLessThan(24);
  });

  it("benefit is exactly $0 when contribution equals max allotment", async () => {
    // HH1 maxAllotment = 292, ceil(net * 0.30) = 292 → net = 973.33
    // ceil(974 * 0.30) = ceil(292.2) = 293 > 292 → benefit = 0
    const result = await calculateBenefitEstimate(974, 1, 2026);
    expect(result.estimatedBenefit).toBe(0);
  });

  it("HH1 zero income gets full max allotment", async () => {
    const result = await calculateBenefitEstimate(0, 1, 2026);
    expect(result.estimatedBenefit).toBe(292);
    expect(result.expectedContribution).toBe(0);
  });
});

// ─── Standard Utility Allowance ────────────────────────────────────────────

describe("getStandardUtilityAllowance", () => {
  it("returns correct amounts for all utility types", () => {
    expect(getStandardUtilityAllowance("HEATING_COOLING")).toBe(414);
    expect(getStandardUtilityAllowance("BASIC")).toBe(284);
    expect(getStandardUtilityAllowance("PHONE_ONLY")).toBe(55);
    expect(getStandardUtilityAllowance("NONE")).toBe(0);
  });

  it("returns 0 for unknown utility type", () => {
    expect(getStandardUtilityAllowance("INVALID")).toBe(0);
    expect(getStandardUtilityAllowance("")).toBe(0);
  });
});

// ─── Rounding and Precision ────────────────────────────────────────────────

describe("Rounding and penny-level precision", () => {
  it("weekly income conversion rounds to 2 decimal places", () => {
    // 333 * 4.333 = 1442.889 → should round to 1442.89
    const result = calculateMonthlyIncome({
      incomeType: "EMPLOYMENT",
      payFrequency: "WEEKLY",
      grossAmountPerPeriod: 333,
    });
    expect(result).toBe(Math.round(333 * 4.333 * 100) / 100);
  });

  it("biweekly income conversion rounds to 2 decimal places", () => {
    // 777 * 2.167 = 1683.759 → should round to 1683.76
    const result = calculateMonthlyIncome({
      incomeType: "EMPLOYMENT",
      payFrequency: "BIWEEKLY",
      grossAmountPerPeriod: 777,
    });
    expect(result).toBe(Math.round(777 * 2.167 * 100) / 100);
  });

  it("deduction totals are rounded to 2 decimal places", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 333 },
      ],
    };

    const result = await calculateDeductions(intake, 2026);

    // Verify all monetary values are properly rounded
    const decimalPlaces = (n) => {
      const str = n.toString();
      const dot = str.indexOf(".");
      return dot === -1 ? 0 : str.length - dot - 1;
    };
    expect(decimalPlaces(result.grossIncome)).toBeLessThanOrEqual(2);
    expect(decimalPlaces(result.netIncome)).toBeLessThanOrEqual(2);
    expect(decimalPlaces(result.totalDeductions)).toBeLessThanOrEqual(2);
  });
});
