import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Consistency Checker Tests
 *
 * Tests all anomaly detection functions that flag data accuracy issues
 * in SNAP intake submissions.
 */

const require_ = setupPrismaMock(import.meta.url);

const {
  checkIncomeVsExpenses,
  checkHouseholdIncomeGaps,
  checkDeductionEligibility,
  checkThresholdProximity,
  checkShelterConsistency,
  checkExpeditedCriteria,
  runConsistencyChecks,
} = require_("../src/services/consistencyChecker");

describe("consistencyChecker", () => {
  describe("checkIncomeVsExpenses", () => {
    it("flags when shelter exceeds 80% of gross income", () => {
      const intake = { shelterExpense: { totalShelterCost: 2000 } };
      const calculations = { deductions: { grossIncome: 2000 } };
      const flags = checkIncomeVsExpenses(intake, calculations);
      expect(flags).toHaveLength(1);
      expect(flags[0].type).toBe("INCOME_EXPENSE_MISMATCH");
      expect(flags[0].severity).toBe("HIGH");
    });

    it("does not flag when shelter is within 80% of income", () => {
      const intake = { shelterExpense: { totalShelterCost: 800 } };
      const calculations = { deductions: { grossIncome: 2000 } };
      const flags = checkIncomeVsExpenses(intake, calculations);
      expect(flags).toHaveLength(0);
    });

    it("does not flag when gross income is zero", () => {
      const intake = { shelterExpense: { totalShelterCost: 500 } };
      const calculations = { deductions: { grossIncome: 0 } };
      const flags = checkIncomeVsExpenses(intake, calculations);
      expect(flags).toHaveLength(0);
    });

    it("does not flag when no shelter expense", () => {
      const intake = {};
      const calculations = { deductions: { grossIncome: 3000 } };
      const flags = checkIncomeVsExpenses(intake, calculations);
      expect(flags).toHaveLength(0);
    });

    it("flags at exactly 80% boundary", () => {
      const intake = { shelterExpense: { totalShelterCost: 1601 } };
      const calculations = { deductions: { grossIncome: 2000 } };
      const flags = checkIncomeVsExpenses(intake, calculations);
      // 1601 > 2000 * 0.8 (1600), should flag
      expect(flags).toHaveLength(1);
    });
  });

  describe("checkHouseholdIncomeGaps", () => {
    it("flags adult household member with no income sources", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "30-39",
            relationshipToApplicant: "spouse",
            inSnapHousehold: true,
            hasEarnedIncome: false,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(1);
      expect(flags[0].type).toBe("HOUSEHOLD_MEMBER_NO_INCOME");
      expect(flags[0].severity).toBe("MEDIUM");
      expect(flags[0].member).toBe("Member 1");
    });

    it("does not flag minors (under 18)", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "under 18",
            relationshipToApplicant: "child",
            inSnapHousehold: true,
            hasEarnedIncome: false,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag members with earned income", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "30-39",
            relationshipToApplicant: "spouse",
            inSnapHousehold: true,
            hasEarnedIncome: true,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag members with unearned income", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "60+",
            relationshipToApplicant: "parent",
            inSnapHousehold: true,
            hasEarnedIncome: false,
            hasUnearnedIncome: true,
          },
        ],
        incomeSources: [],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag members not in SNAP household", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "30-39",
            relationshipToApplicant: "roommate",
            inSnapHousehold: false,
            hasEarnedIncome: false,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag adult with income source linked by ID", () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "30-39",
            relationshipToApplicant: "spouse",
            inSnapHousehold: true,
            hasEarnedIncome: false,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [{ householdMemberId: "m1", incomeType: "SSI" }],
      };
      const flags = checkHouseholdIncomeGaps(intake);
      expect(flags).toHaveLength(0);
    });
  });

  describe("checkDeductionEligibility", () => {
    it("flags dependent care without earned income", () => {
      const intake = {
        deductions: [{ deductionType: "DEPENDENT_CARE", amount: 500 }],
        householdMembers: [],
        incomeSources: [{ incomeType: "SSI" }],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(1);
      expect(flags[0].type).toBe("DEDUCTION_ELIGIBILITY");
      expect(flags[0].message).toContain("Dependent care");
    });

    it("does not flag dependent care with earned income", () => {
      const intake = {
        deductions: [{ deductionType: "DEPENDENT_CARE", amount: 500 }],
        householdMembers: [],
        incomeSources: [{ incomeType: "EMPLOYMENT" }],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(0);
    });

    it("flags medical expenses without elderly/disabled member", () => {
      const intake = {
        deductions: [{ deductionType: "MEDICAL", amount: 200 }],
        householdMembers: [{ isElderly: false, isDisabled: false }],
        incomeSources: [],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(1);
      expect(flags[0].message).toContain("Medical expense");
    });

    it("does not flag medical expenses with elderly member", () => {
      const intake = {
        deductions: [{ deductionType: "MEDICAL", amount: 200 }],
        householdMembers: [{ isElderly: true, isDisabled: false }],
        incomeSources: [],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag medical expenses with disabled member", () => {
      const intake = {
        deductions: [{ deductionType: "MEDICAL", amount: 200 }],
        householdMembers: [{ isElderly: false, isDisabled: true }],
        incomeSources: [],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(0);
    });

    it("flags both dependent care and medical when both ineligible", () => {
      const intake = {
        deductions: [
          { deductionType: "DEPENDENT_CARE", amount: 300 },
          { deductionType: "MEDICAL", amount: 100 },
        ],
        householdMembers: [{ isElderly: false, isDisabled: false }],
        incomeSources: [{ incomeType: "SSI" }],
      };
      const flags = checkDeductionEligibility(intake);
      expect(flags).toHaveLength(2);
    });
  });

  describe("checkThresholdProximity", () => {
    it("flags gross income within 5% of limit", async () => {
      // Mock returns grossIncomeLimit: 2764, 5% = 138.2
      const calculations = {
        deductions: { grossIncome: 2700, netIncome: 1500, householdSize: 3 },
      };
      const result = await checkThresholdProximity({}, calculations, 2026);
      const grossFlag = result.find(
        (f) => f.type === "THRESHOLD_PROXIMITY" && f.message.includes("Gross")
      );
      expect(grossFlag).toBeDefined();
    });

    it("flags net income within 5% of limit", async () => {
      // Mock returns netIncomeLimit: 2127, 5% = 106.35
      const calculations = {
        deductions: { grossIncome: 1500, netIncome: 2100, householdSize: 3 },
      };
      const result = await checkThresholdProximity({}, calculations, 2026);
      const netFlag = result.find(
        (f) => f.type === "THRESHOLD_PROXIMITY" && f.message.includes("Net")
      );
      expect(netFlag).toBeDefined();
    });

    it("does not flag income well below limits", async () => {
      const calculations = {
        deductions: { grossIncome: 1000, netIncome: 800, householdSize: 3 },
      };
      const result = await checkThresholdProximity({}, calculations, 2026);
      expect(result).toHaveLength(0);
    });

    it("flags income just above the limit (still within 5%)", async () => {
      // grossIncomeLimit: 2764, 5% = 138.2, so 2800 is within range
      const calculations = {
        deductions: { grossIncome: 2800, netIncome: 1000, householdSize: 3 },
      };
      const result = await checkThresholdProximity({}, calculations, 2026);
      const grossFlag = result.find((f) => f.message.includes("Gross"));
      expect(grossFlag).toBeDefined();
    });
  });

  describe("checkShelterConsistency", () => {
    it("flags potential utility double-counting when heating/cooling SUA and rent both present", () => {
      const intake = {
        shelterExpense: {
          utilityType: "HEATING_COOLING",
          rentOrMortgage: 1200,
        },
      };
      const flags = checkShelterConsistency(intake);
      expect(flags).toHaveLength(1);
      expect(flags[0].type).toBe("SHELTER_UTILITY_OVERLAP");
      expect(flags[0].severity).toBe("LOW");
    });

    it("does not flag when utility type is not HEATING_COOLING", () => {
      const intake = {
        shelterExpense: {
          utilityType: "BASIC",
          rentOrMortgage: 1200,
        },
      };
      const flags = checkShelterConsistency(intake);
      expect(flags).toHaveLength(0);
    });

    it("does not flag when no shelter expense", () => {
      const flags = checkShelterConsistency({});
      expect(flags).toHaveLength(0);
    });

    it("does not flag when rent is zero", () => {
      const intake = {
        shelterExpense: {
          utilityType: "HEATING_COOLING",
          rentOrMortgage: 0,
        },
      };
      const flags = checkShelterConsistency(intake);
      expect(flags).toHaveLength(0);
    });
  });

  describe("checkExpeditedCriteria", () => {
    it("flags expedited-eligible cases", () => {
      const calculations = {
        expedited: {
          eligible: true,
          reasons: ["Gross monthly income < $150 and liquid resources < $100"],
        },
      };
      const flags = checkExpeditedCriteria(calculations);
      expect(flags).toHaveLength(1);
      expect(flags[0].type).toBe("EXPEDITED_ELIGIBLE");
      expect(flags[0].severity).toBe("INFO");
    });

    it("does not flag non-expedited cases", () => {
      const calculations = {
        expedited: { eligible: false, reasons: [] },
      };
      const flags = checkExpeditedCriteria(calculations);
      expect(flags).toHaveLength(0);
    });

    it("handles missing expedited data", () => {
      const flags = checkExpeditedCriteria({});
      expect(flags).toHaveLength(0);
    });
  });

  describe("runConsistencyChecks (integration)", () => {
    it("returns LOW risk when no flags", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [
          { incomeType: "EMPLOYMENT", snapMonthlyAmount: 1500 },
        ],
        dependentCareExpense: 0,
        medicalExpenses: 0,
      };
      const calculations = {
        deductions: { grossIncome: 1500, netIncome: 1000, householdSize: 3, deductions: [] },
        benefitEstimate: { estimatedBenefit: 400 },
        expedited: { eligible: false, reasons: [] },
      };
      const result = await runConsistencyChecks(intake, calculations, 2026);
      expect(result.riskScore).toBe("LOW");
      expect(result.flags.filter((f) => f.severity === "HIGH")).toHaveLength(0);
    });

    it("returns HIGH risk when HIGH-severity flags exist", async () => {
      const intake = {
        shelterExpense: { totalShelterCost: 2500 },
        householdMembers: [],
        incomeSources: [],
        dependentCareExpense: 500, // claimed with no earned income
        medicalExpenses: 0,
      };
      const calculations = {
        deductions: { grossIncome: 1500, netIncome: 1000, householdSize: 3, deductions: [] },
        benefitEstimate: { estimatedBenefit: 400 },
        expedited: { eligible: false, reasons: [] },
      };
      const result = await runConsistencyChecks(intake, calculations, 2026);
      expect(result.riskScore).toBe("HIGH");
    });

    it("returns MEDIUM risk when only MEDIUM-severity flags exist", async () => {
      const intake = {
        householdMembers: [
          {
            id: "m1",
            displayName: "Member 1",
            ageRange: "30-39",
            relationshipToApplicant: "spouse",
            inSnapHousehold: true,
            hasEarnedIncome: false,
            hasUnearnedIncome: false,
          },
        ],
        incomeSources: [],
        dependentCareExpense: 0,
        medicalExpenses: 0,
      };
      const calculations = {
        deductions: { grossIncome: 1500, netIncome: 1000, householdSize: 3, deductions: [] },
        benefitEstimate: { estimatedBenefit: 400 },
        expedited: { eligible: false, reasons: [] },
      };
      const result = await runConsistencyChecks(intake, calculations, 2026);
      expect(result.riskScore).toBe("MEDIUM");
      expect(result.flags.some((f) => f.type === "HOUSEHOLD_MEMBER_NO_INCOME")).toBe(true);
    });

    it("includes calculation summary in results", async () => {
      const intake = {
        householdMembers: [],
        incomeSources: [],
        dependentCareExpense: 0,
        medicalExpenses: 0,
      };
      const calculations = {
        deductions: { grossIncome: 2000, netIncome: 1500, householdSize: 3, deductions: [{ type: "STANDARD", amount: 209 }] },
        benefitEstimate: { estimatedBenefit: 318 },
        expedited: { eligible: false, reasons: [] },
      };
      const result = await runConsistencyChecks(intake, calculations, 2026);
      expect(result.calculations.grossMonthlyIncome).toBe(2000);
      expect(result.calculations.netMonthlyIncome).toBe(1500);
      expect(result.calculations.estimatedBenefit).toBe(318);
      expect(result.calculations.deductionsApplied).toHaveLength(1);
    });
  });
});
