import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * Seasonal Income + Student Eligibility Persona Tests
 *
 * S01–S10: Seasonal workers reporting slow-period income instead of
 * typical monthly income. Tests the new SEASONAL_INCOME_POSSIBLE check.
 *
 * ST01–ST10: Household members who may be students enrolled in higher
 * education — triggers POSSIBLE_STUDENT_NO_EXEMPTION check for 18–24
 * year-olds with no income.
 */

const require_ = setupPrismaMock(import.meta.url);

const { SEASONAL_STUDENT_PERSONAS } = require("./fixtures/seasonalStudentPersonas.js");

const {
  calculateFullEligibility,
} = require_("../src/services/snapCalculator");

const {
  runConsistencyChecks,
  checkSeasonalIncomePattern,
  checkPossibleStudentInHousehold,
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

describe("Seasonal & Student Personas — Risk Score Validation", () => {
  SEASONAL_STUDENT_PERSONAS.forEach((persona) => {
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

describe("Seasonal & Student Personas — Expected Flags", () => {
  SEASONAL_STUDENT_PERSONAS.forEach((persona) => {
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

// ─── Seasonal Income Scenarios ────────────────────────────────────────────

describe("Seasonal Income Scenarios", () => {
  it("S01: construction worker $100/wk in winter — caseworker should ask about busy season", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "S01");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // $100/wk = $433/mo — well below full-time min wage
    expect(eligibility.deductions.grossIncome).toBeCloseTo(433, 0);
    expect(result.flags.some((f) => f.type === "SEASONAL_INCOME_POSSIBLE")).toBe(true);
    // If typical income is $2800/mo, overpayment difference is massive
  });

  it("S04: landscaper $80/wk winter vs $600/wk summer — huge seasonal swing", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "S04");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // $80/wk = $347/mo — flags as suspiciously low
    expect(eligibility.deductions.grossIncome).toBeCloseTo(347, 0);
    expect(result.flags.some((f) => f.type === "SEASONAL_INCOME_POSSIBLE")).toBe(true);
  });

  it("S02: farm worker $0 in winter — reports during off-season", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "S02");
    const intake = prepareIntake(persona);
    const eligibility = await calculateFullEligibility(intake, "GA", 2026);
    const result = await runConsistencyChecks(intake, eligibility, 2026);

    // $0 income → gets max HH4 benefit $975
    expect(eligibility.benefitEstimate.estimatedBenefit).toBe(975);
    // ZERO_INCOME catches the $0, but the real issue is seasonal
    expect(result.riskScore).toBe("HIGH");
  });

  it("S03 and S10: self-employment seasonal — not caught by SEASONAL_INCOME_POSSIBLE", async () => {
    // Self-employment income is handled differently (annualized, not monthly)
    // so the seasonal check doesn't flag it — but POSSIBLE_UNREPORTED_BENEFITS does
    const s03 = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "S03");
    const intake3 = prepareIntake(s03);
    const elig3 = await calculateFullEligibility(intake3, "GA", 2026);
    const result3 = await runConsistencyChecks(intake3, elig3, 2026);

    expect(result3.flags.some((f) => f.type === "SEASONAL_INCOME_POSSIBLE")).toBe(false);
    expect(result3.flags.some((f) => f.type === "POSSIBLE_UNREPORTED_BENEFITS")).toBe(true);
  });
});

// ─── Student Eligibility Scenarios ────────────────────────────────────────

describe("Student Eligibility Scenarios", () => {
  it("ST01: 19-year-old in HH with no income — should verify student status", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "ST01");
    const intake = prepareIntake(persona);
    const result = await runConsistencyChecks(
      intake,
      await calculateFullEligibility(intake, "GA", 2026),
      2026
    );

    const studentFlag = result.flags.find((f) => f.type === "POSSIBLE_STUDENT_NO_EXEMPTION");
    expect(studentFlag).toBeDefined();
    expect(studentFlag.member).toBe("College Kid");
    expect(studentFlag.suggestedAction).toContain("20+ hrs/wk");
  });

  it("ST03: 20-year-old works 15 hrs/wk — has income linked, so no student flag", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "ST03");
    const intake = prepareIntake(persona);
    const result = await runConsistencyChecks(
      intake,
      await calculateFullEligibility(intake, "GA", 2026),
      2026
    );

    // Has earned income (opts.earned: true) — check should not flag
    const studentFlags = result.flags.filter((f) => f.type === "POSSIBLE_STUDENT_NO_EXEMPTION");
    expect(studentFlags).toHaveLength(0);
  });

  it("ST04: 25-year-old single parent — age 25 not in student-flag range", async () => {
    // The student check only flags 18-24. ST04 is 25 with age range starting at 25.
    // They're flagged for other reasons (POSSIBLE_UNREPORTED_BENEFITS) but not student.
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "ST04");
    const intake = prepareIntake(persona);
    const result = await runConsistencyChecks(
      intake,
      await calculateFullEligibility(intake, "GA", 2026),
      2026
    );

    expect(result.flags.some((f) => f.type === "POSSIBLE_STUDENT_NO_EXEMPTION")).toBe(false);
  });

  it("ST09: 30-year-old back in school + UI — age 30 not flagged for student", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "ST09");
    const intake = prepareIntake(persona);
    const result = await runConsistencyChecks(
      intake,
      await calculateFullEligibility(intake, "GA", 2026),
      2026
    );

    // 30-39 range → not in 18-24 student flag range
    expect(result.flags.some((f) => f.type === "POSSIBLE_STUDENT_NO_EXEMPTION")).toBe(false);
    // But the UI issue is caught
    expect(result.flags.some((f) => f.type === "POSSIBLE_UNREPORTED_BENEFITS")).toBe(true);
  });

  it("ST10: work-study student has income linked — no student flag", async () => {
    const persona = SEASONAL_STUDENT_PERSONAS.find((p) => p.id === "ST10");
    const intake = prepareIntake(persona);
    const result = await runConsistencyChecks(
      intake,
      await calculateFullEligibility(intake, "GA", 2026),
      2026
    );

    // Member has earned: true AND has linked income source
    const studentFlags = result.flags.filter((f) => f.type === "POSSIBLE_STUDENT_NO_EXEMPTION");
    expect(studentFlags).toHaveLength(0);
  });
});

// ─── checkSeasonalIncomePattern Unit Tests ────────────────────────────────

describe("checkSeasonalIncomePattern", () => {
  it("flags employment income < $600/mo with shelter", () => {
    const intake = {
      householdMembers: [],
      incomeSources: [{ incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 100 }],
      shelterExpense: { rentOrMortgage: 700 },
    };
    const flags = checkSeasonalIncomePattern(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("SEASONAL_INCOME_POSSIBLE");
    expect(flags[0].message).toContain("below 20 hrs/wk");
  });

  it("does not flag employment income >= $600/mo", () => {
    const intake = {
      householdMembers: [],
      incomeSources: [{ incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 200 }],
      shelterExpense: { rentOrMortgage: 700 },
    };
    const flags = checkSeasonalIncomePattern(intake);
    expect(flags).toHaveLength(0); // $200 × 4.333 = $867/mo > $600
  });

  it("does not flag self-employment (handled separately)", () => {
    const intake = {
      householdMembers: [],
      incomeSources: [{ incomeType: "SELF_EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 200 }],
      shelterExpense: { rentOrMortgage: 700 },
    };
    const flags = checkSeasonalIncomePattern(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag without shelter costs", () => {
    const intake = {
      householdMembers: [],
      incomeSources: [{ incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 80 }],
    };
    const flags = checkSeasonalIncomePattern(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag elderly/disabled applicant with low part-time income", () => {
    const intake = {
      householdMembers: [
        { id: "__applicant__", isElderly: false, isDisabled: true, inSnapHousehold: true },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", payFrequency: "WEEKLY", grossAmountPerPeriod: 80 }],
      shelterExpense: { rentOrMortgage: 500 },
    };
    const flags = checkSeasonalIncomePattern(intake);
    expect(flags).toHaveLength(0);
  });
});

// ─── checkPossibleStudentInHousehold Unit Tests ───────────────────────────

describe("checkPossibleStudentInHousehold", () => {
  it("flags 18-24 member with no income", () => {
    const intake = {
      householdMembers: [
        { id: "a1", displayName: "Kid", ageRange: "18-24", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe("POSSIBLE_STUDENT_NO_EXEMPTION");
    expect(flags[0].member).toBe("Kid");
  });

  it("does not flag 18-24 member WITH earned income", () => {
    const intake = {
      householdMembers: [
        { id: "a1", displayName: "Working Kid", ageRange: "18-24", inSnapHousehold: true, hasEarnedIncome: true, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag 18-24 member with linked income source", () => {
    const intake = {
      householdMembers: [
        { id: "a1", displayName: "Kid", ageRange: "20-24", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [{ incomeType: "EMPLOYMENT", householdMemberId: "a1", grossAmountPerPeriod: 500 }],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag members under 18", () => {
    const intake = {
      householdMembers: [
        { id: "c1", displayName: "Teen", ageRange: "under 18", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag members 30+", () => {
    const intake = {
      householdMembers: [
        { id: "a1", displayName: "Adult", ageRange: "30-39", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(0);
  });

  it("does not flag __applicant__ phantom member", () => {
    const intake = {
      householdMembers: [
        { id: "__applicant__", displayName: "Applicant", ageRange: "20-24", inSnapHousehold: true, hasEarnedIncome: false, hasUnearnedIncome: false },
      ],
      incomeSources: [],
    };
    const flags = checkPossibleStudentInHousehold(intake);
    expect(flags).toHaveLength(0);
  });
});

// ─── Overpayment Impact ──────────────────────────────────────────────────

describe("Seasonal & Student — Overpayment Impact", () => {
  it("quantifies overpayment for seasonal personas", async () => {
    const seasonal = SEASONAL_STUDENT_PERSONAS.filter((p) => p.category === "seasonal");
    const impacts = [];

    for (const persona of seasonal) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);

      impacts.push({
        id: persona.id,
        reported: `$${eligibility.deductions.grossIncome}`,
        hidden: `$${persona.missingAmount}`,
        benefit: `$${eligibility.benefitEstimate.estimatedBenefit}`,
      });
    }

    expect(impacts).toHaveLength(10);
    for (const impact of impacts) {
      expect(parseInt(impact.benefit.slice(1))).toBeGreaterThan(0);
    }

    console.table(impacts);
  });
});

// ─── Snapshot Generation ─────────────────────────────────────────────────

describe("Seasonal & Student Personas — Snapshot Generation", () => {
  it("generates benchmark data for all 20 personas", async () => {
    const benchmarks = [];

    for (const persona of SEASONAL_STUDENT_PERSONAS) {
      const intake = prepareIntake(persona);
      const eligibility = await calculateFullEligibility(intake, "GA", 2026);
      const consistency = await runConsistencyChecks(intake, eligibility, 2026);

      benchmarks.push({
        id: persona.id,
        category: persona.category,
        householdSize: eligibility.deductions.householdSize,
        reportedGross: eligibility.deductions.grossIncome,
        benefitAtReported: eligibility.benefitEstimate.estimatedBenefit,
        riskScore: consistency.riskScore,
        flagTypes: [...new Set(consistency.flags.map((f) => f.type))],
      });
    }

    expect(benchmarks).toHaveLength(20);
    expect(benchmarks.every((b) => b.riskScore === "MEDIUM" || b.riskScore === "HIGH")).toBe(true);

    console.table(
      benchmarks.map((b) => ({
        ID: b.id,
        Cat: b.category,
        HH: b.householdSize,
        Reported: `$${b.reportedGross}`,
        Benefit: `$${b.benefitAtReported}`,
        Risk: b.riskScore,
        Flags: b.flagTypes.join(", "),
      }))
    );
  });
});
