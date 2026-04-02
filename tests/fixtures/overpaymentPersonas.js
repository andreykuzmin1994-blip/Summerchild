/**
 * 30 Overpayment-Risk SNAP Benchmark Personas (MEDIUM / HIGH risk)
 *
 * Modeled on the top causes of SNAP overpayment per USDA Quality Control data:
 *   ~60% of dollar errors — unreported / underreported income
 *   ~15% — incorrect household composition
 *   ~15% — agency processing errors (pay frequency, data entry)
 *   ~10% — incorrect deduction claims
 *
 * Each persona is designed to trigger one or more consistency checker flags.
 * Organized by the primary overpayment risk pattern.
 *
 * Flag types exercised:
 *   INCOME_EXPENSE_MISMATCH  (HIGH)   — shelter > 80% of gross income
 *   HOUSEHOLD_MEMBER_NO_INCOME (MEDIUM) — working-age adult, no income reported
 *   DEDUCTION_ELIGIBILITY     (HIGH)   — ineligible deduction claimed
 *   THRESHOLD_PROXIMITY       (MEDIUM) — income within 5% of eligibility cutoff
 *   SHELTER_UTILITY_OVERLAP   (LOW)    — heating/cooling SUA with rent
 */

const { member, income, shelter } = require("./benchmarkPersonas.js");

// ─── Helper: shelter with pre-computed totalShelterCost ────────────────────
// The consistency checker uses totalShelterCost for the income/expense check.
function shelterWithTotal(rent, utilityType = "HEATING_COOLING", opts = {}) {
  const sua = { HEATING_COOLING: 414, BASIC: 284, PHONE_ONLY: 55, NONE: 0 };
  const s = {
    rentOrMortgage: rent,
    propertyTax: opts.propertyTax || 0,
    homeownersInsurance: opts.insurance || 0,
    standardUtilityAllowance: sua[utilityType],
    utilityType,
  };
  s.totalShelterCost = rent + s.propertyTax + s.homeownersInsurance + s.standardUtilityAllowance;
  return s;
}

const OVERPAYMENT_PERSONAS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // A. INCOME / EXPENSE MISMATCH (HIGH)
  // Pattern: reported income too low to support stated shelter costs
  // Real-world cause: unreported second job, cash income, partner income
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "OP01",
    name: "Part-time worker, $1100 rent on $866/mo income — likely unreported income",
    overpaymentPattern: "Unreported second job or cash income",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 200)],
      shelterExpense: shelterWithTotal(1100),
      liquidResources: 100,
    },
  },
  {
    id: "OP02",
    name: "SSI recipient, $950 rent — shelter 144% of income",
    overpaymentPattern: "Unreported household member paying rent, or inflated rent",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      shelterExpense: shelterWithTotal(950),
      liquidResources: 50,
    },
  },
  {
    id: "OP03",
    name: "Single mom, 2 kids, $750/mo income but $1200 rent + daycare",
    overpaymentPattern: "Income doesn't cover reported expenses — likely partner income omitted",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 175)],
      dependentCareExpense: 400,
      shelterExpense: shelterWithTotal(1200),
      liquidResources: 50,
    },
  },
  {
    id: "OP04",
    name: "Self-employed, reports $800/mo net but pays $1050 rent",
    overpaymentPattern: "Overstated self-employment expenses to lower countable income",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("SELF_EMPLOYMENT", "MONTHLY", 3000, {
          selfEmploymentGross: 3000,
          selfEmploymentExpenses: 2200,
        }),
      ],
      shelterExpense: shelterWithTotal(1050),
      liquidResources: 200,
    },
  },
  {
    id: "OP05",
    name: "Elderly on $610 SSI, claims $800 rent — who's paying the gap?",
    overpaymentPattern: "Unreported financial support from family member",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSI", "MONTHLY", 610)],
      medicalExpenses: 100,
      shelterExpense: shelterWithTotal(800),
      liquidResources: 75,
    },
    applicantIsElderly: true,
  },
  {
    id: "OP06",
    name: "Couple, one 'unemployed', combined shelter = 95% of reported income",
    overpaymentPattern: "Spouse working under the table",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 550)],
      shelterExpense: shelterWithTotal(1000),
      liquidResources: 100,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // B. WORKING-AGE ADULTS WITH NO INCOME (MEDIUM)
  // Pattern: adult household member with no reported income source
  // Real-world cause: unreported employment, gig work, informal income
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "OP07",
    name: "Married couple, 3 kids, only applicant works — spouse has no income",
    overpaymentPattern: "Spouse may have unreported part-time or gig work",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 700)],
      shelterExpense: shelter(900),
      liquidResources: 150,
    },
  },
  {
    id: "OP08",
    name: "Adult child (22) living at home, no income reported",
    overpaymentPattern: "Young adult likely has some employment — common omission",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "Adult Son", "child", "20-29"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 600)],
      shelterExpense: shelter(750),
      liquidResources: 200,
    },
  },
  {
    id: "OP09",
    name: "Three adults in household, only one income source",
    overpaymentPattern: "Two working-age adults with zero reported income",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Partner", "spouse", "30-39"),
        member("a1", "Adult Sibling", "sibling", "20-29"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 400)],
      shelterExpense: shelter(850),
      liquidResources: 50,
    },
  },
  {
    id: "OP10",
    name: "Couple in 40s, 1 kid, partner claims homemaker — no income gap check",
    overpaymentPattern: "Partner may do informal childcare, cleaning, or gig work for cash",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Partner", "spouse", "40-49"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 650)],
      dependentCareExpense: 0,
      shelterExpense: shelter(800),
      liquidResources: 100,
    },
  },
  {
    id: "OP11",
    name: "Mother + 2 adult daughters + grandkids, only mother works",
    overpaymentPattern: "Multiple working-age adults with no income is a top QC error pattern",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("d1", "Daughter 1", "child", "20-29"),
        member("d2", "Daughter 2", "child", "20-29"),
        member("g1", "Grandchild A", "grandchild", "under 18"),
        member("g2", "Grandchild B", "grandchild", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 750)],
      shelterExpense: shelter(1100),
      liquidResources: 75,
    },
  },
  {
    id: "OP12",
    name: "Boyfriend listed in household, no income, but high shelter",
    overpaymentPattern: "Unmarried partner income is countable if purchasing/preparing food together",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("p1", "Boyfriend", "partner", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 500)],
      shelterExpense: shelter(950),
      liquidResources: 200,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // C. INELIGIBLE DEDUCTION CLAIMS (HIGH)
  // Pattern: claiming deductions that don't match household composition
  // Real-world cause: misunderstanding eligibility, intentional inflation
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "OP13",
    name: "Dependent care claimed but only SSI income — no work activity",
    overpaymentPattern: "Dependent care requires employment or training — none reported",
    expectedFlags: ["DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      deductions: [{ deductionType: "DEPENDENT_CARE", amount: 500 }],
      shelterExpense: shelter(700),
      liquidResources: 50,
    },
  },
  {
    id: "OP14",
    name: "Medical deduction claimed, no elderly/disabled member in household",
    overpaymentPattern: "Medical expenses only deductible for elderly (60+) or disabled members",
    expectedFlags: ["DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 600)],
      deductions: [{ deductionType: "MEDICAL", amount: 250 }],
      shelterExpense: shelter(750),
      liquidResources: 100,
    },
  },
  {
    id: "OP15",
    name: "Both dependent care + medical claimed — neither eligible",
    overpaymentPattern: "Double ineligible deduction — no earned income AND no elderly/disabled",
    expectedFlags: ["DEDUCTION_ELIGIBILITY", "DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      deductions: [
        { deductionType: "DEPENDENT_CARE", amount: 400 },
        { deductionType: "MEDICAL", amount: 200 },
      ],
      shelterExpense: shelter(650),
      liquidResources: 50,
    },
  },
  {
    id: "OP16",
    name: "Dependent care $900/mo claimed — unusually high for single child",
    overpaymentPattern: "Inflated dependent care amount (GA average is $400-$650)",
    expectedFlags: ["DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("CHILD_SUPPORT", "MONTHLY", 400)],
      deductions: [{ deductionType: "DEPENDENT_CARE", amount: 900 }],
      shelterExpense: shelter(600),
      liquidResources: 75,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // D. THRESHOLD PROXIMITY (MEDIUM)
  // Pattern: income lands within 5% of eligibility cutoff
  // Real-world cause: small underreport of hours/wages flips eligibility
  // These are the highest-cost overpayments — person may be fully ineligible
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "OP17",
    name: "HH1, gross $1580 — just under $1632 limit (3.2% below)",
    overpaymentPattern: "One extra unreported shift per month would make ineligible",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 1580)],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 200,
    },
  },
  {
    id: "OP18",
    name: "HH3, gross $2700 — within 5% of $2764 limit",
    overpaymentPattern: "Biweekly pay reported as monthly would undercount by ~8%",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 2700)],
      shelterExpense: shelter(1000),
      liquidResources: 300,
    },
  },
  {
    id: "OP19",
    name: "HH2, net income $1650 — right at $1691 net limit (2.4% below)",
    overpaymentPattern: "Small deduction error flips net income test",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 2100)],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 400,
    },
  },
  {
    id: "OP20",
    name: "HH4, gross $3250 — 2.4% below $3330 limit, border case",
    overpaymentPattern: "Applicant reports monthly pay but actually paid semi-monthly (2 vs 2.167x)",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39", { earned: true }),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "MONTHLY", 2000),
        income("EMPLOYMENT", "MONTHLY", 1250, { memberId: "s1" }),
      ],
      shelterExpense: shelter(1100),
      liquidResources: 250,
    },
  },
  {
    id: "OP21",
    name: "HH5, gross $3800 — 2.5% under $3896 limit with child support",
    overpaymentPattern: "Unreported child support received would push over limit",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
        member("c4", "Child D", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 3800)],
      shelterExpense: shelter(950),
      liquidResources: 100,
    },
  },
  {
    id: "OP22",
    name: "HH1, gross $1600 — exactly at 5% threshold zone",
    overpaymentPattern: "Reports $1600 monthly but pay stubs might show $1700 with overtime",
    expectedFlags: ["THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 1600)],
      shelterExpense: shelter(800),
      liquidResources: 150,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // E. COMPOUND RISK — MULTIPLE FLAGS STACKED
  // Pattern: multiple red flags in same case — highest overpayment risk
  // Real-world: these are the cases QC auditors most often find errors in
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "OP23",
    name: "Income mismatch + no-income spouse + threshold proximity",
    overpaymentPattern: "Triple flag: spouse may have unreported job that covers rent gap",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH", "HOUSEHOLD_MEMBER_NO_INCOME", "THRESHOLD_PROXIMITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 2700)],
      shelterExpense: shelterWithTotal(2300),
      liquidResources: 100,
    },
  },
  {
    id: "OP24",
    name: "No-income partner + ineligible dependent care + shelter overlap",
    overpaymentPattern: "Partner likely working (paying for daycare?) but no income reported",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME", "DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("p1", "Partner", "partner", "20-29"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      deductions: [{ deductionType: "DEPENDENT_CARE", amount: 500 }],
      shelterExpense: shelter(700),
      liquidResources: 50,
    },
  },
  {
    id: "OP25",
    name: "Elderly couple, income mismatch + medical without disabled member proof",
    overpaymentPattern: "High rent on low SS income + medical claimed for non-qualifying member",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH", "DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "50-59"),
      ],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 900)],
      deductions: [{ deductionType: "MEDICAL", amount: 300 }],
      shelterExpense: shelterWithTotal(850),
      liquidResources: 200,
    },
  },
  {
    id: "OP26",
    name: "Large HH, 3 no-income adults + threshold proximity",
    overpaymentPattern: "Most common QC error: unreported income from multiple adults",
    expectedFlags: ["HOUSEHOLD_MEMBER_NO_INCOME", "THRESHOLD_PROXIMITY"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("a1", "Adult Sister", "sibling", "20-29"),
        member("a2", "Adult Brother", "sibling", "20-29"),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      // HH6 gross limit = $4462. $4350 is within 5% ($223 window)
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 4350)],
      shelterExpense: shelter(1100),
      liquidResources: 50,
    },
  },
  {
    id: "OP27",
    name: "Self-employed, inflated expenses + income mismatch + no-income partner",
    overpaymentPattern: "Self-employment expense fraud + unreported partner income",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("p1", "Partner", "partner", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [
        income("SELF_EMPLOYMENT", "MONTHLY", 4000, {
          selfEmploymentGross: 4000,
          selfEmploymentExpenses: 3200,
        }),
      ],
      shelterExpense: shelterWithTotal(1100),
      liquidResources: 150,
    },
  },
  {
    id: "OP28",
    name: "Two ineligible deductions + no-income adult child",
    overpaymentPattern: "Stacked deduction fraud with unreported household member income",
    expectedFlags: ["DEDUCTION_ELIGIBILITY", "DEDUCTION_ELIGIBILITY", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("a1", "Adult Daughter", "child", "20-29"),
        member("c1", "Grandchild", "grandchild", "under 18"),
      ],
      // No earned income (child support is unearned) → dep care ineligible
      // No elderly/disabled member → medical ineligible
      incomeSources: [income("CHILD_SUPPORT", "MONTHLY", 800)],
      deductions: [
        { deductionType: "DEPENDENT_CARE", amount: 400 },
        { deductionType: "MEDICAL", amount: 200 },
      ],
      shelterExpense: shelter(700),
      liquidResources: 100,
    },
  },
  {
    id: "OP29",
    name: "Income mismatch + 2 no-income adults — classic unreported-income pattern",
    overpaymentPattern: "Household of 4 adults, only one reports income, rent exceeds it",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("a1", "Adult Child 1", "child", "20-29"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 350)],
      shelterExpense: shelterWithTotal(1300),
      liquidResources: 50,
    },
  },
  {
    id: "OP30",
    name: "Threshold proximity + income mismatch + ineligible medical — maximum flags",
    overpaymentPattern: "Highest-risk profile: borderline income + expense mismatch + bad deduction",
    expectedFlags: ["THRESHOLD_PROXIMITY", "INCOME_EXPENSE_MISMATCH", "DEDUCTION_ELIGIBILITY"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 2150)],
      deductions: [{ deductionType: "MEDICAL", amount: 180 }],
      shelterExpense: shelterWithTotal(1800),
      liquidResources: 100,
    },
  },
];

module.exports = { OVERPAYMENT_PERSONAS, shelterWithTotal };
