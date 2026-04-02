import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Unreported Income Persona Tests
 *
 * 25 scenarios where applicants don't realize certain income counts for SNAP.
 * Covers: UI benefits, workers' comp, regular cash gifts, room rental,
 * alimony, TANF, informal self-employment, day labor, gig work.
 *
 * UI16-UI25: UI combination scenarios — UI + Social Security, UI + 401k,
 * UI + pension, UI + VA, UI + SSDI, UI + child support, UI + rental income,
 * SS + 401k, and multi-source misses (UI + job + cash).
 *
 * Also tests the POSSIBLE_UNREPORTED_BENEFITS consistency check.
 */

const require_ = setupPrismaMock(import.meta.url);

const { UNREPORTED_INCOME_PERSONAS } = require("./fixtures/unreportedIncomePersonas.js");
const { member } = require("./fixtures/benchmarkPersonas.js");

const {
  calculateFullEligibility,
} = require_("../src/services/snapCalculator");

const {
  runConsistencyChecks,
  checkPossibleUnreportedBenefits,
} = require_("../src/services/consistencyChecker");

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

// ─── Risk Score Validation ─────────────────────────────────────────────────

describe("Unreported Income Personas — Risk Score Validation", () => {
  UNREPORTED_INCOME_PERSONAS.forEach((persona) => {
    it(`${persona.id}: ${persona.name} → ${persona.expectedRisk} risk`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      expect(["MEDIUM", "HIGH"]).toContain(result.riskScore);
      expect(result.riskScore).toBe(persona.expectedRisk);
    });
  });
});

// ─── Expected Flags Fire ───────────────────────────────────────────────────

describe("Unreported Income Personas — Expected Flags", () => {
  UNREPORTED_INCOME_PERSONAS.forEach((persona) => {
    it(`${persona.id} triggers ${persona.expectedFlags.join(" + ")}`, async () => {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const result = await runConsistencyChecks(intake, eligibility, 2026);

      const flagTypes = result.flags.map((f) => f.type);

      for (const expected of persona.expectedFlags) {
        expect(flagTypes).toContain(expected);
      }
    });
  });
});

// ─── UI-Specific Scenarios ─────────────────────────────────────────────────

describe("UI Benefit Scenarios", () => {
  it("UI01: zero income + rent → caseworker should ask about UI", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI01");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // Gets max benefit — this is the overpayment amount if UI isn't counted
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(292);
    expect(result.riskScore).toBe("HIGH");

    // If UI $320/wk were reported, monthly gross = $1386
    // That's below HH1 $1632 limit, so still eligible but lower benefit
    // Overpayment without UI reporting: ~$125/mo
  });

  it("UI02: family with $0 income gets max allotment — massive overpayment risk", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI02");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);

    // HH2 max allotment at $0 income
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(536);
    expect(eligibility.expedited.eligible).toBe(true);
  });

  it("UI03: part-time job reported but partial UI not — still eligible but overpaid", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI03");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // Only reports $200/wk = $866.60/mo gross
    // Missing ~$780/mo UI → actual gross would be ~$1647
    expect(eligibility.deductions.grossIncome).toBeCloseTo(866.6, 0);
    expect(result.flags.some((f) => f.type === "POSSIBLE_UNREPORTED_BENEFITS")).toBe(true);
  });

  it("UI04: both spouses' UI unreported — double overpayment", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI04");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // HH3 at $0 = max $768 benefit
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(768);
    // Multiple flags should fire
    expect(result.flags.some((f) => f.type === "ZERO_INCOME_WITH_SHELTER")).toBe(true);
    expect(result.flags.some((f) => f.type === "HOUSEHOLD_MEMBER_NO_INCOME")).toBe(true);
  });
});

// ─── Overpayment Impact Calculation ────────────────────────────────────────

describe("Unreported Income — Overpayment Impact", () => {
  it("quantifies monthly overpayment for each persona", async () => {
    const impacts = [];

    for (const persona of UNREPORTED_INCOME_PERSONAS) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);

      impacts.push({
        id: persona.id,
        name: persona.name,
        missingType: persona.missingIncomeType,
        missingAmount: `$${persona.missingAmount}/mo`,
        reportedGross: `$${eligibility.deductions.grossIncome}`,
        benefitAtReported: `$${eligibility.benefitEstimate.estimatedBenefit}`,
        whyUnreported: persona.whyUnreported,
      });
    }

    expect(impacts).toHaveLength(25);

    // Every persona should be getting benefits (eligible at reported income)
    for (const impact of impacts) {
      expect(parseInt(impact.benefitAtReported.slice(1))).toBeGreaterThan(0);
    }

    console.table(
      impacts.map((i) => ({
        ID: i.id,
        Missing: i.missingType,
        Hidden: i.missingAmount,
        Reported: i.reportedGross,
        Benefit: i.benefitAtReported,
      }))
    );
  });
});

// ─── UI Combination Scenarios (UI16–UI25) ─────────────────────────────────

describe("UI Combination Scenarios", () => {
  it("UI16: early retiree SS + UI — only reports SS, UI is the hidden income", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI16");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);

    // Reports SS $1450/mo, missing UI $1300/mo → actual gross would be $2750
    expect(eligibility.deductions.grossIncome).toBe(1450);
    // Still eligible at reported income (HH2 elderly, skips gross test)
    expect(eligibility.eligible).toBe(true);
  });

  it("UI17: 401k + UI both unreported — maximum overpayment risk", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI17");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // Gets max HH1 benefit at $0 reported
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(292);
    // With actual $3213/mo income, would exceed HH1 $1632 gross limit → ineligible
    expect(result.riskScore).toBe("HIGH");
  });

  it("UI18: couple where both incomes unreported — spouse SS + applicant UI", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI18");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // HH2 at $0 income = max $536 benefit
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(536);
    // Actual $3036/mo would far exceed HH2 $2204 gross limit
    expect(result.flags.some((f) => f.type === "ZERO_INCOME_WITH_SHELTER")).toBe(true);
    expect(result.flags.some((f) => f.type === "HOUSEHOLD_MEMBER_NO_INCOME")).toBe(true);
  });

  it("UI22: single mom reports child support but not UI — common pattern", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI22");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);

    // Reports only $450/mo CS for HH3 → gets near-max benefit
    expect(eligibility.deductions.grossIncome).toBe(450);
    // With UI $1386 added, gross would be $1836 — still under HH3 $2776 but much lower benefit
    expect(eligibility.eligible).toBe(true);
  });

  it("UI24: retiree SS + 401k withdrawals — 401k is 'savings not income'", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI24");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);

    // Reports SS $1800/mo, missing 401k $1500/mo → actual $3300/mo
    // HH2 elderly gross limit is N/A (skip gross test), net limit $1698
    // At reported $1800, net after deductions likely still eligible
    expect(eligibility.deductions.grossIncome).toBe(1800);
    expect(eligibility.eligible).toBe(true);
  });

  it("UI25: triple miss — job + UI + cash, only reports the job", async () => {
    const persona = UNREPORTED_INCOME_PERSONAS.find((p) => p.id === "UI25");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // Reports $200/wk = $866.60/mo, missing $1700/mo
    expect(eligibility.deductions.grossIncome).toBeCloseTo(866.6, 0);
    // Earned only, no unearned → POSSIBLE_UNREPORTED_BENEFITS fires
    expect(result.flags.some((f) => f.type === "POSSIBLE_UNREPORTED_BENEFITS")).toBe(true);
  });
});

// ─── checkPossibleUnreportedBenefits Unit Tests ────────────────────────────

describe("checkPossibleUnreportedBenefits", () => {
  it("flags earned-only household with working-age adults", () => {
    const intake = {
      householdMembers: [
        { id: "s1", ageRange: "30-39", inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1000 }],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("POSSIBLE_UNREPORTED_BENEFITS");
    expect(flags[0].message).toContain("unemployment");
  });

  it("flags zero-income household with working-age adults", () => {
    const intake = {
      householdMembers: [
        { id: "s1", ageRange: "30-39", inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("$0 reported income");
  });

  it("does not flag household that already reports unearned income", () => {
    const intake = {
      householdMembers: [
        { id: "s1", ageRange: "30-39", inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [
        { incomeType: "EMPLOYMENT", grossAmountPerPeriod: 1000 },
        { incomeType: "UNEMPLOYMENT", grossAmountPerPeriod: 300 },
      ],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag elderly-only household with earned income", () => {
    const intake = {
      householdMembers: [
        { id: "__applicant__", ageRange: "60+", inSnapHousehold: true, isElderly: true, isDisabled: false },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 500 }],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag household with only unearned income", () => {
    const intake = {
      householdMembers: [
        { id: "s1", ageRange: "40-49", inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [{ incomeType: "SSI", grossAmountPerPeriod: 943 }],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag household with no working-age adults (elderly applicant + children)", () => {
    const intake = {
      householdMembers: [
        { id: "__applicant__", ageRange: "60+", inSnapHousehold: true, isElderly: true, isDisabled: false },
        { id: "c1", ageRange: "under 18", inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 800 }],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag disabled applicant household (may legitimately have only SSI)", () => {
    const intake = {
      householdMembers: [
        { id: "__applicant__", ageRange: "30-39", inSnapHousehold: true, isElderly: false, isDisabled: true },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", grossAmountPerPeriod: 300 }],
    };
    const flags = checkPossibleUnreportedBenefits(intake);
    expect(flags).toHaveLength(0);
  });
});

// ─── Snapshot ──────────────────────────────────────────────────────────────

describe("Unreported Income Personas — Snapshot Generation", () => {
  it("generates benchmark data for all 25 personas", async () => {
    const benchmarks = [];

    for (const persona of UNREPORTED_INCOME_PERSONAS) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const consistency = await runConsistencyChecks(intake, eligibility, 2026);

      benchmarks.push({
        id: persona.id,
        name: persona.name,
        householdSize: eligibility.deductions.householdSize,
        reportedGross: eligibility.deductions.grossIncome,
        missingAmount: persona.missingAmount,
        benefitAtReported: eligibility.benefitEstimate.estimatedBenefit,
        eligible: eligibility.eligible,
        riskScore: consistency.riskScore,
        flagCount: consistency.flags.length,
        flagTypes: [...new Set(consistency.flags.map((f) => f.type))],
      });
    }

    expect(benchmarks).toHaveLength(25);

    // All should be MEDIUM or HIGH
    expect(benchmarks.every((b) => b.riskScore === "MEDIUM" || b.riskScore === "HIGH")).toBe(true);

    console.table(
      benchmarks.map((b) => ({
        ID: b.id,
        HH: b.householdSize,
        Reported: `$${b.reportedGross}`,
        Hidden: `$${b.missingAmount}`,
        Benefit: `$${b.benefitAtReported}`,
        Risk: b.riskScore,
        Flags: b.flagTypes.join(", "),
      }))
    );
  });
});
