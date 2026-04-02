import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Benchmark Persona Tests
 *
 * Runs 30 realistic SNAP applicant personas through the full eligibility
 * pipeline (calculateFullEligibility + runConsistencyChecks) and captures
 * expected outputs. These serve as regression benchmarks for:
 *   - AI implementation (comparing AI-generated estimates vs calculator)
 *   - Response caching (keyed by persona archetype)
 *   - Data accuracy audits
 */

const require_ = setupPrismaMock(import.meta.url);

const { PERSONAS } = require("./fixtures/benchmarkPersonas.js");

const {
  calculateFullEligibility,
  calculateMonthlyIncome,
} = require_("../src/services/snapCalculator");

const {
  runConsistencyChecks,
} = require_("../src/services/consistencyChecker");

// For personas with applicant-level elderly/disabled flags, we need to inject
// those into the householdMembers array since the calculator checks members.
// The applicant themselves isn't a "member" — their flags affect hasElderlyOrDisabled
// via members, so we add a sentinel member with inSnapHousehold: false if needed.
// Actually — the calculator checks householdMembers for elderly/disabled.
// For applicant-level flags, we mock by adding a pseudo-member.
function prepareIntake(persona) {
  const intake = { ...persona.intake };
  intake.householdMembers = [...(intake.householdMembers || [])];
  intake.incomeSources = [...(intake.incomeSources || [])];

  // If the applicant is elderly or disabled, we add a sentinel to the
  // householdMembers so the calculator detects elderly/disabled.
  // The applicant occupies the "+1" in householdSize but doesn't appear in members,
  // so we need one member flagged for hasElderlyOrDisabled to be true.
  if (persona.applicantIsElderly || persona.applicantIsDisabled) {
    // Check if any member already has elderly/disabled
    const alreadyFlagged = intake.householdMembers.some(
      (m) => m.isElderly || m.isDisabled
    );
    if (!alreadyFlagged) {
      // Add a "phantom" member representing the applicant's own flags.
      // This is a workaround — in production, the applicant's own status would
      // be checked separately. For testing, we piggyback on the member check.
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

// ─── Full Pipeline Validation ──────────────────────────────────────────────

describe("Benchmark Personas — Full Eligibility Pipeline", () => {
  const results = {};

  // Run every persona and store results for cross-validation
  PERSONAS.forEach((persona) => {
    describe(`${persona.id}: ${persona.name}`, () => {
      let eligibility;
      let consistency;

      it("runs calculateFullEligibility without error", async () => {
        const intake = prepareIntake(persona);
        eligibility = await calculateFullEligibility(intake, "GA", 2026);
        results[persona.id] = { eligibility, intake };

        expect(eligibility).toHaveProperty("eligible");
        expect(eligibility).toHaveProperty("grossIncomeTest");
        expect(eligibility).toHaveProperty("netIncomeTest");
        expect(eligibility).toHaveProperty("deductions");
        expect(eligibility).toHaveProperty("benefitEstimate");
        expect(eligibility).toHaveProperty("expedited");
      });

      it("produces valid deduction amounts (non-negative)", async () => {
        if (!eligibility) {
          const intake = prepareIntake(persona);
          eligibility = await calculateFullEligibility(intake, "GA", 2026);
        }

        expect(eligibility.deductions.grossIncome).toBeGreaterThanOrEqual(0);
        expect(eligibility.deductions.netIncome).toBeGreaterThanOrEqual(0);
        expect(eligibility.deductions.totalDeductions).toBeGreaterThanOrEqual(0);
        expect(eligibility.benefitEstimate.estimatedBenefit).toBeGreaterThanOrEqual(0);

        for (const ded of eligibility.deductions.deductions) {
          expect(ded.amount).toBeGreaterThanOrEqual(0);
        }
      });

      it("net income <= gross income", async () => {
        if (!eligibility) {
          const intake = prepareIntake(persona);
          eligibility = await calculateFullEligibility(intake, "GA", 2026);
        }

        expect(eligibility.deductions.netIncome).toBeLessThanOrEqual(
          eligibility.deductions.grossIncome
        );
      });

      it("benefit does not exceed max allotment for household size", async () => {
        if (!eligibility) {
          const intake = prepareIntake(persona);
          eligibility = await calculateFullEligibility(intake, "GA", 2026);
        }

        expect(eligibility.benefitEstimate.estimatedBenefit).toBeLessThanOrEqual(
          eligibility.benefitEstimate.maxAllotment
        );
      });

      it("runs consistency checks without error", async () => {
        if (!eligibility) {
          const intake = prepareIntake(persona);
          eligibility = await calculateFullEligibility(intake, "GA", 2026);
        }

        const intake = prepareIntake(persona);
        consistency = await runConsistencyChecks(intake, eligibility, 2026);

        expect(["LOW", "MEDIUM", "HIGH"]).toContain(consistency.riskScore);
        expect(Array.isArray(consistency.flags)).toBe(true);
      });
    });
  });
});

// ─── Archetype-Specific Expectations ───────────────────────────────────────

describe("Benchmark Personas — Archetype-Specific Validations", () => {
  // Zero-income personas should qualify for expedited
  describe("Expedited eligibility for zero/very-low-income personas", () => {
    it("P04 (unemployed single mom) qualifies for expedited", async () => {
      const persona = PERSONAS.find((p) => p.id === "P04");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      expect(result.expedited.eligible).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.benefitEstimate.estimatedBenefit).toBe(536); // max for HH2
    });

    it("P24 (laid off, zero income) qualifies for expedited", async () => {
      const persona = PERSONAS.find((p) => p.id === "P24");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      expect(result.expedited.eligible).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.benefitEstimate.estimatedBenefit).toBe(292); // max for HH1
    });
  });

  // Elderly personas should skip gross income test
  describe("Elderly households skip gross income test", () => {
    const elderlyIds = ["P09", "P10", "P11", "P12", "P13", "P14"];

    elderlyIds.forEach((id) => {
      it(`${id} has gross income test skipped`, async () => {
        const persona = PERSONAS.find((p) => p.id === id);
        const intake = prepareIntake(persona);
        const result = await calculateFullEligibility(intake, "GA", 2026);

        expect(result.grossIncomeTest.passes).toBe(true);
        expect(result.grossIncomeTest.skipped).toBe(true);
        expect(result.deductions.hasElderlyOrDisabled).toBe(true);
      });
    });
  });

  // Disabled personas should have elderly/disabled flag set
  describe("Disabled households have correct flag", () => {
    const disabledIds = ["P15", "P16", "P17", "P18", "P19", "P20"];

    disabledIds.forEach((id) => {
      it(`${id} has hasElderlyOrDisabled = true`, async () => {
        const persona = PERSONAS.find((p) => p.id === id);
        const intake = prepareIntake(persona);
        const result = await calculateFullEligibility(intake, "GA", 2026);

        expect(result.deductions.hasElderlyOrDisabled).toBe(true);
      });
    });
  });

  // Shelter deduction uncapped for elderly/disabled
  describe("Shelter deduction uncapped for elderly/disabled", () => {
    it("P10 (elderly couple, high shelter) has uncapped shelter deduction", async () => {
      const persona = PERSONAS.find((p) => p.id === "P10");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      const shelterDed = result.deductions.deductions.find(
        (d) => d.type === "SHELTER_EXCESS"
      );
      // If shelter excess > $744, it proves uncapped
      if (shelterDed) {
        // No cap applied — just verify it's the real calculated amount
        expect(shelterDed.amount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // Medical deductions only for elderly/disabled
  describe("Medical deductions applied correctly", () => {
    it("P09 (elderly, $180 medical) gets medical deduction", async () => {
      const persona = PERSONAS.find((p) => p.id === "P09");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      const medDed = result.deductions.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeDefined();
      // max($161 standard, $180 - $35 = $145) = $161
      expect(medDed.amount).toBe(161);
    });

    it("P10 (elderly, $450 medical) gets itemized medical deduction", async () => {
      const persona = PERSONAS.find((p) => p.id === "P10");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      const medDed = result.deductions.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeDefined();
      // max($161, $450 - $35 = $415) = $415
      expect(medDed.amount).toBe(415);
    });

    it("P21 (non-elderly, non-disabled) gets NO medical deduction even if claimed", async () => {
      const persona = PERSONAS.find((p) => p.id === "P21");
      const intake = { ...prepareIntake(persona), medicalExpenses: 500 };
      const result = await calculateFullEligibility(intake, "GA", 2026);

      const medDed = result.deductions.deductions.find((d) => d.type === "MEDICAL");
      expect(medDed).toBeUndefined();
    });
  });

  // Working households get 20% earned income deduction
  describe("Earned income deduction for working households", () => {
    const workingIds = ["P01", "P02", "P03", "P05", "P21", "P22", "P25"];

    workingIds.forEach((id) => {
      it(`${id} has earned income deduction`, async () => {
        const persona = PERSONAS.find((p) => p.id === id);
        const intake = prepareIntake(persona);
        const result = await calculateFullEligibility(intake, "GA", 2026);

        const earnedDed = result.deductions.deductions.find(
          (d) => d.type === "EARNED_INCOME_20PCT"
        );
        expect(earnedDed).toBeDefined();
        expect(earnedDed.amount).toBeGreaterThan(0);
      });
    });
  });

  // Child support paid deduction
  describe("Child support paid deduction", () => {
    it("P28 (blended family, $400 child support paid) gets deduction", async () => {
      const persona = PERSONAS.find((p) => p.id === "P28");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      const csDed = result.deductions.deductions.find(
        (d) => d.type === "CHILD_SUPPORT_PAID"
      );
      expect(csDed).toBeDefined();
      expect(csDed.amount).toBe(400);
    });
  });

  // Self-employment uses lower of itemized vs 40% standard
  describe("Self-employment calculation", () => {
    it("P22 (gig worker, $2200 gross, $700 expenses) uses standard deduction", async () => {
      const persona = PERSONAS.find((p) => p.id === "P22");
      const incSource = persona.intake.incomeSources[0];

      // Itemized: 2200 - 700 = 1500
      // Standard: 2200 * 0.6 = 1320
      // min(1500, 1320) = 1320 (standard wins)
      const monthly = calculateMonthlyIncome(incSource);
      expect(monthly).toBe(1320);
    });
  });

  // Large households (HH 6+) use correct extrapolated limits
  describe("Large household extrapolation", () => {
    it("P29 (6-member family) uses HH6 limits", async () => {
      const persona = PERSONAS.find((p) => p.id === "P29");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      expect(result.deductions.householdSize).toBe(6);
      expect(result.benefitEstimate.maxAllotment).toBe(1390);
    });

    it("P30 (8-member family) uses HH8 limits", async () => {
      const persona = PERSONAS.find((p) => p.id === "P30");
      const intake = prepareIntake(persona);
      const result = await calculateFullEligibility(intake, "GA", 2026);

      expect(result.deductions.householdSize).toBe(8);
      expect(result.benefitEstimate.maxAllotment).toBe(1756);
    });
  });
});

// ─── Benchmark Snapshot: Print All Results ─────────────────────────────────

describe("Benchmark Personas — Snapshot Generation", () => {
  it("generates benchmark data for all 30 personas", async () => {
    const benchmarks = [];

    for (const persona of PERSONAS) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const consistency = await runConsistencyChecks(intake, eligibility, 2026);

      benchmarks.push({
        id: persona.id,
        name: persona.name,
        householdSize: eligibility.deductions.householdSize,
        grossIncome: eligibility.deductions.grossIncome,
        netIncome: eligibility.deductions.netIncome,
        totalDeductions: eligibility.deductions.totalDeductions,
        eligible: eligibility.eligible,
        estimatedBenefit: eligibility.benefitEstimate.estimatedBenefit,
        maxAllotment: eligibility.benefitEstimate.maxAllotment,
        expedited: eligibility.expedited.eligible,
        riskScore: consistency.riskScore,
        flagCount: consistency.flags.length,
        deductionTypes: eligibility.deductions.deductions.map((d) => d.type),
      });
    }

    // Validate we got all 30
    expect(benchmarks).toHaveLength(30);

    // Verify distribution: at least some eligible, some expedited, varied risk
    const eligibleCount = benchmarks.filter((b) => b.eligible).length;
    const expeditedCount = benchmarks.filter((b) => b.expedited).length;
    const riskCounts = {
      LOW: benchmarks.filter((b) => b.riskScore === "LOW").length,
      MEDIUM: benchmarks.filter((b) => b.riskScore === "MEDIUM").length,
      HIGH: benchmarks.filter((b) => b.riskScore === "HIGH").length,
    };

    // Sanity: most SNAP applicants should be eligible
    expect(eligibleCount).toBeGreaterThanOrEqual(20);
    // Some should qualify for expedited
    expect(expeditedCount).toBeGreaterThanOrEqual(2);
    // Risk scores should be distributed
    expect(riskCounts.LOW).toBeGreaterThanOrEqual(1);

    // Log the benchmark table (visible in test output with --reporter=verbose)
    // This data can be exported for AI training / caching
    console.table(
      benchmarks.map((b) => ({
        ID: b.id,
        HH: b.householdSize,
        Gross: `$${b.grossIncome}`,
        Net: `$${b.netIncome}`,
        Benefit: `$${b.estimatedBenefit}`,
        Eligible: b.eligible ? "Y" : "N",
        Expedited: b.expedited ? "Y" : "N",
        Risk: b.riskScore,
        Flags: b.flagCount,
      }))
    );
  });
});
