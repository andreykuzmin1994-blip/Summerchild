import { describe, it, expect } from "vitest";
import { setupPrismaMock } from "./helpers/mockPrisma.js";

/**
 * SNAP Eligibility Rules — Gherkin-Style BDD Tests
 *
 * Human-readable policy scenario tests following the 18F pattern.
 * Each test reads like a regulation scenario:
 *   Given [household situation]
 *   When [calculation is performed]
 *   Then [expected outcome with CFR citation]
 *
 * These tests serve as living documentation of SNAP policy rules
 * and can be reviewed by policy experts who aren't developers.
 */

const require_ = setupPrismaMock(import.meta.url);

const {
  calculateDeductions,
  checkGrossIncomeTest,
  checkNetIncomeTest,
  calculateBenefitEstimate,
  checkExpeditedEligibility,
  calculateFullEligibility,
  calculateMonthlyIncome,
  getStandardUtilityAllowance,
} = require_("../src/services/snapCalculator");

// ── Scenario: Gross Income Test [7 CFR § 273.9(a)] ──────────────────────

describe("Gross Income Test [7 CFR § 273.9(a)]", () => {
  it(`Given a household of 3 with $2,000 gross monthly income
      When the gross income test is run
      Then it passes because $2,000 < $2,764 (130% FPL for HH3)`, async () => {
    const result = await checkGrossIncomeTest(2000, 3, "GA", false);
    expect(result.passes).toBe(true);
    expect(result.limit).toBe(2764);
    expect(result.explanation).toContain("at or below the limit");
    expect(result.explanation).toContain("7 CFR § 273.9(a)");
  });

  it(`Given a household of 3 with $3,000 gross monthly income
      When the gross income test is run
      Then it fails because $3,000 > $2,764 (130% FPL for HH3)`, async () => {
    const result = await checkGrossIncomeTest(3000, 3, "GA", false);
    expect(result.passes).toBe(false);
    expect(result.explanation).toContain("exceeds the limit");
  });

  it(`Given a household of 3 with an elderly member and $3,000 gross income
      When the gross income test is run
      Then it is skipped because elderly/disabled households are exempt`, async () => {
    const result = await checkGrossIncomeTest(3000, 3, "GA", true);
    expect(result.passes).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.explanation).toContain("exempt from the gross income test");
  });

  it(`Given a household of 1 at exactly the gross income limit ($1,632)
      When the gross income test is run
      Then it passes because $1,632 ≤ $1,632`, async () => {
    const result = await checkGrossIncomeTest(1632, 1, "GA", false);
    expect(result.passes).toBe(true);
  });

  it(`Given a household of 1 at $1 over the gross income limit ($1,633)
      When the gross income test is run
      Then it fails because $1,633 > $1,632`, async () => {
    const result = await checkGrossIncomeTest(1633, 1, "GA", false);
    expect(result.passes).toBe(false);
  });
});

// ── Scenario: Net Income Test [7 CFR § 273.9(a)] ────────────────────────

describe("Net Income Test [7 CFR § 273.9(a)]", () => {
  it(`Given a household of 4 with $2,000 net monthly income
      When the net income test is run
      Then it passes because $2,000 < $2,563 (100% FPL for HH4)`, async () => {
    const result = await checkNetIncomeTest(2000, 4);
    expect(result.passes).toBe(true);
    expect(result.limit).toBe(2563);
    expect(result.explanation).toContain("100% of the Federal Poverty Level");
  });

  it(`Given a household of 4 with $2,700 net monthly income
      When the net income test is run
      Then it fails because $2,700 > $2,563`, async () => {
    const result = await checkNetIncomeTest(2700, 4);
    expect(result.passes).toBe(false);
    expect(result.explanation).toContain("not passed");
  });
});

// ── Scenario: Standard Deduction [7 CFR § 273.9(d)(2)] ──────────────────

describe("Standard Deduction [7 CFR § 273.9(d)(2)]", () => {
  it(`Given a household of 3
      When deductions are calculated
      Then the standard deduction is $209 for households of 1-3`, async () => {
    const intake = { incomeSources: [], householdMembers: [
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
    ]};
    const result = await calculateDeductions(intake);
    const stdDed = result.deductions.find(d => d.type === "STANDARD");
    expect(stdDed.amount).toBe(209);
    expect(stdDed.explanation).toContain("household of 3");
    expect(stdDed.explanation).toContain("7 CFR § 273.9(d)(2)");
  });

  it(`Given a household of 5
      When deductions are calculated
      Then the standard deduction is $261`, async () => {
    const intake = { incomeSources: [], householdMembers: [
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
      { inSnapHousehold: true, isElderly: false, isDisabled: false },
    ]};
    const result = await calculateDeductions(intake);
    const stdDed = result.deductions.find(d => d.type === "STANDARD");
    expect(stdDed.amount).toBe(261);
  });
});

// ── Scenario: 20% Earned Income Deduction [7 CFR § 273.9(d)(1)] ─────────

describe("20% Earned Income Deduction [7 CFR § 273.9(d)(1)]", () => {
  it(`Given a household with $2,000/month earned income
      When deductions are calculated
      Then the earned income deduction is $400 (20% of $2,000)`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
      ],
      householdMembers: [],
    };
    const result = await calculateDeductions(intake);
    const eid = result.deductions.find(d => d.type === "EARNED_INCOME_20PCT");
    expect(eid.amount).toBe(400);
    expect(eid.explanation).toContain("20%");
    expect(eid.explanation).toContain("7 CFR § 273.9(d)(1)");
  });

  it(`Given a household with only unearned income (Social Security)
      When deductions are calculated
      Then no earned income deduction is applied`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 900 },
      ],
      householdMembers: [],
    };
    const result = await calculateDeductions(intake);
    const eid = result.deductions.find(d => d.type === "EARNED_INCOME_20PCT");
    expect(eid).toBeUndefined();
  });
});

// ── Scenario: Dependent Care Deduction [7 CFR § 273.9(d)(3)] ────────────

describe("Dependent Care Deduction [7 CFR § 273.9(d)(3)]", () => {
  it(`Given a household with $300/month dependent care expense
      When deductions are calculated
      Then the full $300 is deducted`, async () => {
    const intake = {
      incomeSources: [],
      householdMembers: [],
      dependentCareExpense: 300,
    };
    const result = await calculateDeductions(intake);
    const dc = result.deductions.find(d => d.type === "DEPENDENT_CARE");
    expect(dc.amount).toBe(300);
    expect(dc.explanation).toContain("7 CFR § 273.9(d)(3)");
  });
});

// ── Scenario: Medical Deduction for Elderly/Disabled [7 CFR § 273.9(d)(6)] ──

describe("Medical Deduction [7 CFR § 273.9(d)(6)]", () => {
  it(`Given an elderly member with $200/month medical expenses
      When deductions are calculated
      Then the medical deduction is $165 (actual excess: $200 - $35 = $165, which exceeds $161 standard)`, async () => {
    const intake = {
      incomeSources: [],
      householdMembers: [{ inSnapHousehold: true, isElderly: true, isDisabled: false }],
      medicalExpenses: 200,
    };
    const result = await calculateDeductions(intake);
    const med = result.deductions.find(d => d.type === "MEDICAL");
    expect(med.amount).toBe(165); // $200 - $35 = $165 > $161 standard
    expect(med.explanation).toContain("7 CFR § 273.9(d)(6)");
  });

  it(`Given an elderly member with $50/month medical expenses
      When deductions are calculated
      Then the standard medical deduction of $161 applies (since $50 - $35 = $15 < $161)`, async () => {
    const intake = {
      incomeSources: [],
      householdMembers: [{ inSnapHousehold: true, isElderly: true, isDisabled: false }],
      medicalExpenses: 50,
    };
    const result = await calculateDeductions(intake);
    const med = result.deductions.find(d => d.type === "MEDICAL");
    expect(med.amount).toBe(161); // standard deduction is higher
  });

  it(`Given a non-elderly, non-disabled household with $200/month medical expenses
      When deductions are calculated
      Then no medical deduction is applied`, async () => {
    const intake = {
      incomeSources: [],
      householdMembers: [{ inSnapHousehold: true, isElderly: false, isDisabled: false }],
      medicalExpenses: 200,
    };
    const result = await calculateDeductions(intake);
    const med = result.deductions.find(d => d.type === "MEDICAL");
    expect(med).toBeUndefined();
  });
});

// ── Scenario: Child Support Deduction [7 CFR § 273.9(d)(4)] ─────────────

describe("Child Support Deduction [7 CFR § 273.9(d)(4)]", () => {
  it(`Given a household paying $250/month in child support
      When deductions are calculated
      Then the full $250 is deducted`, async () => {
    const intake = {
      incomeSources: [],
      householdMembers: [],
      childSupportPaid: 250,
    };
    const result = await calculateDeductions(intake);
    const cs = result.deductions.find(d => d.type === "CHILD_SUPPORT_PAID");
    expect(cs.amount).toBe(250);
    expect(cs.explanation).toContain("7 CFR § 273.9(d)(4)");
  });
});

// ── Scenario: Shelter Excess Deduction [7 CFR § 273.9(d)(5)] ────────────

describe("Shelter Excess Deduction [7 CFR § 273.9(d)(5)]", () => {
  it(`Given a household of 3 with $1,200 rent, heating/cooling utility, $2,000 earned income, no elderly/disabled
      When deductions are calculated
      Then the shelter excess is capped at $744`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
      ],
      householdMembers: [
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      shelterExpense: {
        rentOrMortgage: 1200,
        standardUtilityAllowance: 414,
      },
    };
    const result = await calculateDeductions(intake);
    const shelter = result.deductions.find(d => d.type === "SHELTER_EXCESS");
    expect(shelter).toBeDefined();
    // Gross: $2000, Std ded: $209, EID: $400 → remaining: $2000 - $609 = $1391
    // Shelter: $1614, half remaining: $695.50, excess: $918.50, capped at $744
    expect(shelter.amount).toBe(744);
    expect(shelter.explanation).toContain("capped at $744");
    expect(shelter.explanation).toContain("7 CFR § 273.9(d)(5)");
  });

  it(`Given the same household but with an elderly member
      When deductions are calculated
      Then the shelter excess is NOT capped`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
      ],
      householdMembers: [
        { inSnapHousehold: true, isElderly: true, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      shelterExpense: {
        rentOrMortgage: 1200,
        standardUtilityAllowance: 414,
      },
    };
    const result = await calculateDeductions(intake);
    const shelter = result.deductions.find(d => d.type === "SHELTER_EXCESS");
    expect(shelter).toBeDefined();
    expect(shelter.amount).toBeGreaterThan(744);
    expect(shelter.explanation).toContain("not capped");
  });
});

// ── Scenario: Income Conversion [7 CFR § 273.10(c)] ─────────────────────

describe("Income Conversion [7 CFR § 273.10(c)]", () => {
  it(`Given a worker paid $500/week
      When income is converted to monthly
      Then it equals $2,166.50 (500 × 4.333)`, () => {
    const result = calculateMonthlyIncome({
      incomeType: "EMPLOYMENT",
      payFrequency: "WEEKLY",
      grossAmountPerPeriod: 500,
    });
    expect(result).toBeCloseTo(2166.50, 0);
  });

  it(`Given a worker paid $1,147.50 biweekly
      When income is converted to monthly
      Then it equals approximately $2,486.62 (1147.50 × 2.167)`, () => {
    const result = calculateMonthlyIncome({
      incomeType: "EMPLOYMENT",
      payFrequency: "BIWEEKLY",
      grossAmountPerPeriod: 1147.50,
    });
    expect(result).toBeCloseTo(2486.62, 0);
  });
});

// ── Scenario: Self-Employment [7 CFR § 273.11(a)] ───────────────────────

describe("Self-Employment Income [7 CFR § 273.11(a)]", () => {
  it(`Given a self-employed person with $3,000 gross and $1,500 business expenses
      When income is calculated
      Then itemized ($1,500) is used because it is lower than standard ($1,800)`, () => {
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 3000,
      selfEmploymentExpenses: 1500,
      grossAmountPerPeriod: 3000,
    });
    expect(result).toBe(1500);
  });

  it(`Given a self-employed person with $3,000 gross and $200 business expenses
      When income is calculated
      Then standard 40% deduction ($1,800) is used because it is lower than itemized ($2,800)`, () => {
    const result = calculateMonthlyIncome({
      incomeType: "SELF_EMPLOYMENT",
      selfEmploymentGross: 3000,
      selfEmploymentExpenses: 200,
      grossAmountPerPeriod: 3000,
    });
    expect(result).toBe(1800);
  });
});

// ── Scenario: Expedited Processing [7 CFR § 273.2(i)] ───────────────────

describe("Expedited Processing [7 CFR § 273.2(i)]", () => {
  it(`Given gross income $100, liquid resources $50, rent $800, utilities $414
      When expedited eligibility is checked
      Then it qualifies on BOTH conditions`, () => {
    const result = checkExpeditedEligibility(100, 50, 800, 414);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(2);
    expect(result.explanation).toContain("expedited (7-day) processing");
    expect(result.explanation).toContain("7 CFR § 273.2(i)(1)");
  });

  it(`Given gross income $500, liquid resources $100, rent $800, utilities $414
      When expedited eligibility is checked
      Then it qualifies because $600 combined < $1,214 shelter`, () => {
    const result = checkExpeditedEligibility(500, 100, 800, 414);
    expect(result.eligible).toBe(true);
    expect(result.explanation).toContain("Combined income and resources");
  });

  it(`Given gross income $2,000, liquid resources $500, rent $800, utilities $414
      When expedited eligibility is checked
      Then it does NOT qualify (neither condition met)`, () => {
    const result = checkExpeditedEligibility(2000, 500, 800, 414);
    expect(result.eligible).toBe(false);
    expect(result.explanation).toContain("does not meet");
  });
});

// ── Scenario: Benefit Calculation [7 CFR § 273.10(e)] ────────────────────

describe("Benefit Calculation [7 CFR § 273.10(e)]", () => {
  it(`Given a household of 3 with $500 net income
      When the benefit is estimated
      Then benefit = $768 max - $150 (30% of $500) = $618`, async () => {
    const result = await calculateBenefitEstimate(500, 3);
    expect(result.maxAllotment).toBe(768);
    expect(result.expectedContribution).toBe(150); // ceil(500 * 0.30)
    expect(result.estimatedBenefit).toBe(618);
    expect(result.explanation).toContain("7 CFR § 273.10(e)");
  });

  it(`Given a household of 1 with $200 net income
      When the benefit is estimated
      Then benefit = max($292 - $60, $24 minimum) = $232`, async () => {
    const result = await calculateBenefitEstimate(200, 1);
    expect(result.estimatedBenefit).toBe(232);
  });

  it(`Given a household of 1 with $900 net income
      When the benefit is estimated
      Then benefit = $292 - $270 = $22, bumped to $24 minimum`, async () => {
    const result = await calculateBenefitEstimate(900, 1);
    expect(result.expectedContribution).toBe(270); // ceil(900 * 0.30)
    expect(result.estimatedBenefit).toBe(24); // minimum benefit
    expect(result.explanation).toContain("at least $24");
  });

  it(`Given a household of 3 with very high net income ($5,000)
      When the benefit is estimated
      Then benefit = $0 (expected contribution exceeds max allotment)`, async () => {
    const result = await calculateBenefitEstimate(5000, 3);
    expect(result.estimatedBenefit).toBe(0);
    expect(result.explanation).toContain("$0");
  });
});

// ── Scenario: Standard Utility Allowances (Georgia FY2026) ──────────────

describe("Standard Utility Allowances [7 CFR § 273.9(d)(5)(iii)]", () => {
  it(`Given a household with heating/cooling
      Then the SUA is $414`, () => {
    expect(getStandardUtilityAllowance("HEATING_COOLING")).toBe(414);
  });

  it(`Given a household with basic utilities only
      Then the SUA is $284`, () => {
    expect(getStandardUtilityAllowance("BASIC")).toBe(284);
  });

  it(`Given a household with phone service only
      Then the SUA is $55`, () => {
    expect(getStandardUtilityAllowance("PHONE_ONLY")).toBe(55);
  });
});

// ── Scenario: Full Eligibility Pipeline ──────────────────────────────────

describe("Full Eligibility Determination", () => {
  it(`Given a household of 3: applicant earns $2,000/mo, spouse gets $892/mo SSI,
      pays $1,200 rent with heating/cooling, $300 dependent care
      When full eligibility is calculated
      Then all tests, deductions, benefit, and explanation are produced`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 2000 },
        { incomeType: "SOCIAL_SECURITY", payFrequency: "MONTHLY", grossAmountPerPeriod: 892 },
      ],
      householdMembers: [
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      dependentCareExpense: 300,
      shelterExpense: {
        rentOrMortgage: 1200,
        standardUtilityAllowance: 414,
      },
    };

    const result = await calculateFullEligibility(intake);

    // Gross: $2000 + $892 = $2892
    expect(result.deductions.grossIncome).toBe(2892);
    expect(result.deductions.householdSize).toBe(3);

    // HH3 gross limit is $2764, $2892 > $2764 → fails gross income test
    expect(result.grossIncomeTest.passes).toBe(false);

    // Full explanation is generated
    expect(result.explanation).toBeDefined();
    expect(result.explanation).toContain("SNAP ELIGIBILITY CALCULATION SUMMARY");
    expect(result.explanation).toContain("DEDUCTIONS APPLIED");
    expect(result.explanation).toContain("INCOME TESTS");
    expect(result.explanation).toContain("BENEFIT ESTIMATE");
    expect(result.explanation).toContain("EXPEDITED PROCESSING");
  });

  it(`Given an eligible household of 3: applicant earns $1,500/mo, $1,000 rent with heating
      When full eligibility is calculated
      Then the household passes both income tests and receives a benefit estimate`, async () => {
    const intake = {
      incomeSources: [
        { incomeType: "EMPLOYMENT", payFrequency: "MONTHLY", grossAmountPerPeriod: 1500 },
      ],
      householdMembers: [
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
        { inSnapHousehold: true, isElderly: false, isDisabled: false },
      ],
      shelterExpense: {
        rentOrMortgage: 1000,
        standardUtilityAllowance: 414,
      },
    };

    const result = await calculateFullEligibility(intake);

    // Gross: $1500, HH3 limit: $2764 → passes
    expect(result.grossIncomeTest.passes).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.benefitEstimate.estimatedBenefit).toBeGreaterThan(0);
    expect(result.explanation).toContain("SNAP ELIGIBILITY CALCULATION SUMMARY");
  });
});
