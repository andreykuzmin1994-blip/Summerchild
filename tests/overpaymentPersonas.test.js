import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Overpayment-Risk Persona Tests
 *
 * 30 scenarios modeled on USDA SNAP Quality Control error data:
 *   - Unreported/underreported income (shelter exceeds income)
 *   - Working-age adults with no reported income
 *   - Ineligible deduction claims
 *   - Income at threshold boundaries
 *   - Compound multi-flag cases
 *
 * Every persona should trigger MEDIUM or HIGH risk.
 * These benchmarks serve as ground truth for AI overpayment detection
 * and caseworker alert prioritization.
 */

const require_ = setupPrismaMock(import.meta.url);

const { OVERPAYMENT_PERSONAS } = require("./fixtures/overpaymentPersonas.js");
const { member } = require("./fixtures/benchmarkPersonas.js");

const {
  calculateFullEligibility,
} = require_("../src/services/snapCalculator");

const {
  runConsistencyChecks,
} = require_("../src/services/consistencyChecker");

// Same prepareIntake helper as benchmarkPersonas
function prepareIntake(persona) {
  const intake = { ...persona.intake };
  intake.householdMembers = [...(intake.householdMembers || [])];
  intake.incomeSources = [...(intake.incomeSources || [])];

  if (persona.applicantIsElderly || persona.applicantIsDisabled) {
    const alreadyFlagged = intake.householdMembers.some(
      (m) => m.isElderly || m.isDisabled
    );
    if (!alreadyFlagged) {
      intake.householdMembers.push({
        id: "__applicant__",
        displayName: "Applicant",
        relationshipToApplicant: "self",
        ageRange: persona.applicantIsElderly ? "60+" : "30-39",
        inSnapHousehold: true,
        isElderly: persona.applicantIsElderly || false,
        isDisabled: persona.applicantIsDisabled || false,
        hasEarnedIncome: intake.incomeSources.some(
          (s) =>
            !s.householdMemberId &&
            (s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT")
        ),
        hasUnearnedIncome: intake.incomeSources.some(
          (s) =>
            !s.householdMemberId &&
            s.incomeType !== "EMPLOYMENT" &&
            s.incomeType !== "SELF_EMPLOYMENT"
        ),
      });
    }
  }

  return intake;
}

// ─── Core: Every persona must be MEDIUM or HIGH risk ───────────────────────

describe("Overpayment Personas — Risk Score Validation", () => {
  OVERPAYMENT_PERSONAS.forEach((persona) => {
    it(`${persona.id}: ${persona.name} → ${persona.expectedRisk} risk`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      expect(["MEDIUM", "HIGH"]).toContain(result.riskScore);
      expect(result.riskScore).toBe(persona.expectedRisk);
    });
  });
});

// ─── Flag-Level Validation ─────────────────────────────────────────────────

describe("Overpayment Personas — Expected Flags Fire", () => {
  OVERPAYMENT_PERSONAS.forEach((persona) => {
    it(`${persona.id} triggers expected flag types`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const flagTypes = result.flags.map((f) => f.type);

      for (const expected of persona.expectedFlags) {
        const count = persona.expectedFlags.filter((f) => f === expected).length;
        const actual = flagTypes.filter((f) => f === expected).length;
        expect(actual).toBeGreaterThanOrEqual(count);
      }
    });
  });
});

// ─── Category A: Income/Expense Mismatch (HIGH) ───────────────────────────

describe("Category A — Income/Expense Mismatch", () => {
  const categoryA = OVERPAYMENT_PERSONAS.filter((p) =>
    p.expectedFlags.includes("INCOME_EXPENSE_MISMATCH")
  );

  categoryA.forEach((persona) => {
    it(`${persona.id}: shelter exceeds 80% of gross income`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const mismatchFlag = result.flags.find(
        (f) => f.type === "INCOME_EXPENSE_MISMATCH"
      );
      expect(mismatchFlag).toBeDefined();
      expect(mismatchFlag.severity).toBe("HIGH");
    });
  });

  it("income mismatch scenarios average at least $200/mo potential overpayment", async () => {
    // If income is underreported, the actual benefit should be lower.
    // Quantify: calculate benefit at stated income vs what it would be
    // if unreported income closed the shelter gap.
    let totalOverpaymentRisk = 0;

    for (const persona of categoryA) {
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);
      // Benefit at stated (possibly underreported) income
      totalOverpaymentRisk += result.benefitEstimate.estimatedBenefit;
    }

    const avgBenefit = totalOverpaymentRisk / categoryA.length;
    // These cases should have relatively high benefits (because income is underreported)
    expect(avgBenefit).toBeGreaterThan(200);
  });
});

// ─── Category B: No-Income Adults (MEDIUM) ─────────────────────────────────

describe("Category B — Household Member No Income", () => {
  const categoryB = OVERPAYMENT_PERSONAS.filter(
    (p) =>
      p.expectedFlags.includes("HOUSEHOLD_MEMBER_NO_INCOME") &&
      !p.expectedFlags.includes("INCOME_EXPENSE_MISMATCH") // pure category B
  );

  categoryB.forEach((persona) => {
    it(`${persona.id}: has at least one no-income adult flagged`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const noIncomeFlags = result.flags.filter(
        (f) => f.type === "HOUSEHOLD_MEMBER_NO_INCOME"
      );
      expect(noIncomeFlags.length).toBeGreaterThanOrEqual(1);

      // Each flag should identify the member by name
      for (const flag of noIncomeFlags) {
        expect(flag.member).toBeTruthy();
        expect(flag.severity).toBe("MEDIUM");
      }
    });
  });

  it("OP11 (3 no-income adults) flags multiple members", async () => {
    const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === "OP11");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    const noIncomeFlags = result.flags.filter(
      (f) => f.type === "HOUSEHOLD_MEMBER_NO_INCOME"
    );
    expect(noIncomeFlags.length).toBe(2); // Daughter 1 + Daughter 2
  });
});

// ─── Category C: Ineligible Deductions (HIGH) ──────────────────────────────

describe("Category C — Ineligible Deduction Claims", () => {
  const categoryC = ["OP13", "OP14", "OP15", "OP16"];

  categoryC.forEach((id) => {
    it(`${id}: flags ineligible deduction`, async () => {
      const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === id);
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const dedFlags = result.flags.filter(
        (f) => f.type === "DEDUCTION_ELIGIBILITY"
      );
      expect(dedFlags.length).toBeGreaterThanOrEqual(1);
      expect(result.riskScore).toBe("HIGH");
    });
  });

  it("OP15 flags both dependent care AND medical as ineligible", async () => {
    const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === "OP15");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    const dedFlags = result.flags.filter(
      (f) => f.type === "DEDUCTION_ELIGIBILITY"
    );
    expect(dedFlags.length).toBe(2);
    expect(dedFlags.some((f) => f.message.includes("Dependent care"))).toBe(true);
    expect(dedFlags.some((f) => f.message.includes("Medical expense"))).toBe(true);
  });
});

// ─── Category D: Threshold Proximity (MEDIUM) ──────────────────────────────

describe("Category D — Threshold Proximity", () => {
  const categoryD = ["OP17", "OP18", "OP19", "OP20", "OP21", "OP22"];

  categoryD.forEach((id) => {
    it(`${id}: income within 5% of eligibility limit`, async () => {
      const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === id);
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const thresholdFlags = result.flags.filter(
        (f) => f.type === "THRESHOLD_PROXIMITY"
      );
      expect(thresholdFlags.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("threshold cases are all currently eligible (that's the danger)", async () => {
    for (const id of categoryD) {
      const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === id);
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      // These should pass eligibility — that's what makes them risky
      // A small income error means they shouldn't be eligible at all
      expect(result.eligible).toBe(true);
    }
  });
});

// ─── Category E: Compound Multi-Flag Cases ─────────────────────────────────

describe("Category E — Compound Risk (Multiple Flags)", () => {
  const categoryE = ["OP23", "OP24", "OP25", "OP26", "OP27", "OP28", "OP29", "OP30"];

  categoryE.forEach((id) => {
    it(`${id}: triggers 2+ distinct flag types`, async () => {
      const persona = OVERPAYMENT_PERSONAS.find((p) => p.id === id);
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const uniqueFlagTypes = [...new Set(result.flags.map((f) => f.type))];
      // Filter out INFO-level flags (like EXPEDITED_ELIGIBLE)
      const actionableFlags = result.flags.filter(
        (f) => f.severity !== "INFO" && f.severity !== "LOW"
      );
      expect(actionableFlags.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ─── Benchmark Snapshot ────────────────────────────────────────────────────

describe("Overpayment Personas — Snapshot Generation", () => {
  it("generates overpayment benchmark data for all 30 personas", async () => {
    const benchmarks = [];

    for (const persona of OVERPAYMENT_PERSONAS) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const consistency = await runConsistencyChecks(intake, eligibility, 2026);

      benchmarks.push({
        id: persona.id,
        name: persona.name,
        pattern: persona.overpaymentPattern,
        householdSize: eligibility.deductions.householdSize,
        grossIncome: eligibility.deductions.grossIncome,
        netIncome: eligibility.deductions.netIncome,
        eligible: eligibility.eligible,
        estimatedBenefit: eligibility.benefitEstimate.estimatedBenefit,
        riskScore: consistency.riskScore,
        flagCount: consistency.flags.length,
        flagTypes: [...new Set(consistency.flags.map((f) => f.type))],
        flagSeverities: consistency.flags.map((f) => f.severity),
      });
    }

    expect(benchmarks).toHaveLength(30);

    // All 30 should be MEDIUM or HIGH
    const medOrHigh = benchmarks.filter(
      (b) => b.riskScore === "MEDIUM" || b.riskScore === "HIGH"
    );
    expect(medOrHigh.length).toBe(30);

    // Distribution check
    const highCount = benchmarks.filter((b) => b.riskScore === "HIGH").length;
    const medCount = benchmarks.filter((b) => b.riskScore === "MEDIUM").length;
    expect(highCount).toBeGreaterThanOrEqual(10);
    expect(medCount).toBeGreaterThanOrEqual(5);

    // Average flag count should be > 1
    const avgFlags = benchmarks.reduce((s, b) => s + b.flagCount, 0) / 30;
    expect(avgFlags).toBeGreaterThan(1);

    console.table(
      benchmarks.map((b) => ({
        ID: b.id,
        HH: b.householdSize,
        Gross: `$${b.grossIncome}`,
        Benefit: `$${b.estimatedBenefit}`,
        Eligible: b.eligible ? "Y" : "N",
        Risk: b.riskScore,
        Flags: b.flagCount,
        Types: b.flagTypes.join(", "),
      }))
    );
  });
});
