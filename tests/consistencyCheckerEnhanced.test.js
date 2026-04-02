import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Enhanced Consistency Checker Tests
 *
 * Tests the 5 new overpayment detection checks added based on USDA QC data:
 *   1. Zero income with shelter costs
 *   2. Self-employment high expense ratio
 *   3. Pay frequency plausibility
 *   4. Medical expense reasonableness
 *   5. Multiple no-income adults escalation
 */

const require_ = setupPrismaMock(import.meta.url);

const {
  checkZeroIncomeWithShelter,
  checkSelfEmploymentExpenses,
  checkPayFrequencyPlausibility,
  checkMedicalExpenseReasonableness,
  checkMultipleAdultsNoIncome,
  runConsistencyChecks,
} = require_("../src/services/consistencyChecker");

// ─── 1. Zero Income With Shelter ───────────────────────────────────────────

describe("checkZeroIncomeWithShelter", () => {
  it("flags $0 income with rent > $0", () => {
    const intake = { shelterExpense: { rentOrMortgage: 800 } };
    const calculations = { deductions: { grossIncome: 0 } };
    const flags = checkZeroIncomeWithShelter(intake, calculations);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("ZERO_INCOME_WITH_SHELTER");
    expect(flags[0].severity).toBe("HIGH");
    expect(flags[0].message).toContain("$800");
  });

  it("does not flag when income > 0", () => {
    const intake = { shelterExpense: { rentOrMortgage: 800 } };
    const calculations = { deductions: { grossIncome: 500 } };
    const flags = checkZeroIncomeWithShelter(intake, calculations);
    expect(flags).toHaveLength(0);
  });

  it("does not flag zero income with $0 rent", () => {
    const intake = { shelterExpense: { rentOrMortgage: 0 } };
    const calculations = { deductions: { grossIncome: 0 } };
    const flags = checkZeroIncomeWithShelter(intake, calculations);
    expect(flags).toHaveLength(0);
  });

  it("does not flag zero income with no shelter expense", () => {
    const intake = {};
    const calculations = { deductions: { grossIncome: 0 } };
    const flags = checkZeroIncomeWithShelter(intake, calculations);
    expect(flags).toHaveLength(0);
  });

  it("does not flag zero income with undefined rent", () => {
    const intake = { shelterExpense: {} };
    const calculations = { deductions: { grossIncome: 0 } };
    const flags = checkZeroIncomeWithShelter(intake, calculations);
    expect(flags).toHaveLength(0);
  });
});

// ─── 2. Self-Employment High Expenses ──────────────────────────────────────

describe("checkSelfEmploymentExpenses", () => {
  it("flags expenses > 60% of gross", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 3000,
          selfEmploymentExpenses: 2000,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("SELF_EMPLOYMENT_HIGH_EXPENSES");
    expect(flags[0].severity).toBe("MEDIUM");
    expect(flags[0].message).toContain("67%");
  });

  it("flags expenses at 80% (extreme)", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 5000,
          selfEmploymentExpenses: 4000,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("80%");
  });

  it("does not flag expenses at exactly 60%", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 5000,
          selfEmploymentExpenses: 3000,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag expenses below 60%", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 5000,
          selfEmploymentExpenses: 2000,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag non-self-employment income", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1000 },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag zero gross", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 0,
          selfEmploymentExpenses: 0,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(0);
  });

  it("flags each self-employment source independently", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 2000,
          selfEmploymentExpenses: 1500,
        },
        {
          incomeType: "SELF_EMPLOYMENT",
          selfEmploymentGross: 3000,
          selfEmploymentExpenses: 2100,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(2);
  });

  it("uses grossAmountPerPeriod as fallback for gross", () => {
    const intake = {
      incomeSources: [
        {
          incomeType: "SELF_EMPLOYMENT",
          grossAmountPerPeriod: 2000,
          selfEmploymentExpenses: 1500,
        },
      ],
    };
    const flags = checkSelfEmploymentExpenses(intake);
    expect(flags).toHaveLength(1);
  });
});

// ─── 3. Pay Frequency Plausibility ─────────────────────────────────────────

describe("checkPayFrequencyPlausibility", () => {
  it("flags monthly $1400 as possible biweekly", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1400 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("PAY_FREQUENCY_SUSPICIOUS");
    expect(flags[0].severity).toBe("MEDIUM");
    expect(flags[0].message).toContain("biweekly");
  });

  it("flags monthly $580 (common biweekly for min wage)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 580 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(1);
  });

  it("does not flag monthly $2500 (clearly monthly salary)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2500 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag monthly $300 (below suspicious range)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 300 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag biweekly frequency (already correct type)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "BIWEEKLY", grossAmountPerPeriod: 700 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag weekly frequency", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 500 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(0);
  });

  it("skips self-employment sources", () => {
    const intake = {
      incomeSources: [
        { incomeType: "SELF_EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1000 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(0);
  });

  it("flags at lower boundary ($400)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 400 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(1);
  });

  it("flags at upper boundary ($1800)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1800 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    expect(flags).toHaveLength(1);
  });

  it("calculates correct biweekly equivalent", () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1000 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    // $1000 × 2.167 = $2167.00
    expect(flags[0].message).toContain("$2167.00");
  });

  it("flags unearned income types too (SSI reported as monthly)", () => {
    const intake = {
      incomeSources: [
        { incomeType: "SSI", payFrequency: "MONTHLY", grossAmountPerPeriod: 943 },
      ],
    };
    const flags = checkPayFrequencyPlausibility(intake);
    // SSI at $943 falls in the range — technically it IS monthly for SSI,
    // but the checker flags it for review. Caseworker can dismiss.
    expect(flags).toHaveLength(1);
  });
});

// ─── 4. Medical Expense Reasonableness ─────────────────────────────────────

describe("checkMedicalExpenseReasonableness", () => {
  it("flags medical expenses over $400", () => {
    const intake = { medicalExpenses: 500 };
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("MEDICAL_EXPENSE_HIGH");
    expect(flags[0].severity).toBe("MEDIUM");
    expect(flags[0].message).toContain("$500");
  });

  it("does not flag medical expenses at $400", () => {
    const intake = { medicalExpenses: 400 };
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag medical expenses below $400", () => {
    const intake = { medicalExpenses: 200 };
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag zero medical expenses", () => {
    const intake = { medicalExpenses: 0 };
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when medicalExpenses is undefined", () => {
    const intake = {};
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(0);
  });

  it("flags $401 (just over threshold)", () => {
    const intake = { medicalExpenses: 401 };
    const flags = checkMedicalExpenseReasonableness(intake);
    expect(flags).toHaveLength(1);
  });
});

// ─── 5. Multiple Adults No Income ──────────────────────────────────────────

describe("checkMultipleAdultsNoIncome", () => {
  it("flags when 2+ adults have no income", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "20-29", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("MULTIPLE_ADULTS_NO_INCOME");
    expect(flags[0].severity).toBe("HIGH");
    expect(flags[0].message).toContain("2 working-age adults");
  });

  it("flags 3 no-income adults with correct count", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "20-29", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a3", ageRange: "40-49", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("3 working-age adults");
  });

  it("does not flag when only 1 adult has no income", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: true, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag minors", () => {
    const intake = {
      householdMembers: [
        { id: "c1", ageRange: "under 18", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "c2", ageRange: "under 18", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not count adults with linked income sources", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [{ householdMemberId: "a1", incomeType: "SSI" }],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    // Only a2 has no income — just 1 adult, doesn't trigger
    expect(flags).toHaveLength(0);
  });

  it("does not count members outside SNAP household", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "30-39", inSnapHousehold: false, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not count adults with unearned income", () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "60+", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: true },
      ],
      incomeSources: [],
    };
    const flags = checkMultipleAdultsNoIncome(intake);
    expect(flags).toHaveLength(0);
  });
});

// ─── Integration: New checks fire in runConsistencyChecks ──────────────────

describe("runConsistencyChecks — enhanced checks integration", () => {
  it("zero income + rent triggers HIGH via new check", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: { rentOrMortgage: 700 },
    };
    const calculations = {
      deductions: { grossIncome: 0, netIncome: 0, householdSize: 1, deductions: [] },
      benefitEstimate: { estimatedBenefit: 292 },
      expedited: { eligible: true, reasons: ["test"] },
    };
    const result = await runConsistencyChecks(intake, calculations, 2026);
    expect(result.riskScore).toBe("HIGH");
    expect(result.flags.some((f) => f.type === "ZERO_INCOME_WITH_SHELTER")).toBe(true);
  });

  it("self-employment high expenses triggers MEDIUM", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [
        { incomeType: "SELF_EMPLOYMENT", selfEmploymentGross: 3000, selfEmploymentExpenses: 2400 },
      ],
    };
    const calculations = {
      deductions: { grossIncome: 600, netIncome: 300, householdSize: 1, deductions: [] },
      benefitEstimate: { estimatedBenefit: 200 },
      expedited: { eligible: false, reasons: [] },
    };
    const result = await runConsistencyChecks(intake, calculations, 2026);
    expect(result.flags.some((f) => f.type === "SELF_EMPLOYMENT_HIGH_EXPENSES")).toBe(true);
  });

  it("pay frequency suspicious triggers MEDIUM", async () => {
    const intake = {
      householdMembers: [],
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1400 },
      ],
    };
    const calculations = {
      deductions: { grossIncome: 1400, netIncome: 900, householdSize: 1, deductions: [] },
      benefitEstimate: { estimatedBenefit: 100 },
      expedited: { eligible: false, reasons: [] },
    };
    const result = await runConsistencyChecks(intake, calculations, 2026);
    expect(result.flags.some((f) => f.type === "PAY_FREQUENCY_SUSPICIOUS")).toBe(true);
  });

  it("high medical expense triggers MEDIUM", async () => {
    const intake = {
      householdMembers: [{ isElderly: true, isDisabled: false }],
      incomeSources: [{ incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 1200 }],
      medicalExpenses: 600,
    };
    const calculations = {
      deductions: { grossIncome: 1200, netIncome: 400, householdSize: 1, deductions: [] },
      benefitEstimate: { estimatedBenefit: 200 },
      expedited: { eligible: false, reasons: [] },
    };
    const result = await runConsistencyChecks(intake, calculations, 2026);
    expect(result.flags.some((f) => f.type === "MEDICAL_EXPENSE_HIGH")).toBe(true);
  });

  it("multiple no-income adults triggers HIGH", async () => {
    const intake = {
      householdMembers: [
        { id: "a1", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
        { id: "a2", ageRange: "20-29", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 }],
    };
    const calculations = {
      deductions: { grossIncome: 2000, netIncome: 1500, householdSize: 3, deductions: [] },
      benefitEstimate: { estimatedBenefit: 300 },
      expedited: { eligible: false, reasons: [] },
    };
    const result = await runConsistencyChecks(intake, calculations, 2026);
    expect(result.riskScore).toBe("HIGH");
    expect(result.flags.some((f) => f.type === "MULTIPLE_ADULTS_NO_INCOME")).toBe(true);
  });
});
