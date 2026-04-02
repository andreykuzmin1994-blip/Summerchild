/**
 * 25 Unreported Income Benchmark Personas
 *
 * Scenarios where applicants don't realize certain income counts for SNAP.
 * These are the most common "honest mistake" overpayment patterns — not fraud,
 * but misunderstanding about what SNAP considers income.
 *
 * Organized by the type of income that's missing from the application.
 * Each persona includes:
 *   - reported: what the applicant enters (missing income)
 *   - actualIncome: what they're really receiving (for overpayment calculation)
 *   - missingIncomeType: the income they forgot to report
 *   - missingAmount: monthly amount not reported
 *   - whyUnreported: the applicant's reasoning
 *
 * GA UI benefits: max $365/week for 14-26 weeks. Average ~$280-320/week.
 */

const { member, income, shelter } = require("./benchmarkPersonas.js");

const UNREPORTED_INCOME_PERSONAS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // UNEMPLOYMENT INSURANCE (most common unreported benefit)
  // "I'm unemployed — I have no income"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI01",
    name: "Just laid off, receiving UI $320/wk, reports $0 income",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1386, // 320 × 4.333
    whyUnreported: "Applicant equates 'unemployed' with 'no income' — doesn't consider UI a job",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(750),
      liquidResources: 200,
    },
  },
  {
    id: "UI02",
    name: "Receiving UI + applied for SNAP same week, only reports old job ending",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1213, // 280 × 4.333
    whyUnreported: "Applied for UI and SNAP simultaneously — thinks UI hasn't 'started' yet",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(850),
      liquidResources: 150,
    },
  },
  {
    id: "UI03",
    name: "Partial UI + part-time job, only reports the part-time job",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 780, // partial UI ~$180/wk × 4.333
    whyUnreported: "Thinks UI stopped when part-time work started — GA allows partial UI",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      // Only reports the part-time job
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 200)],
      shelterExpense: shelter(900),
      liquidResources: 100,
    },
  },
  {
    id: "UI04",
    name: "UI exhausted last month, spouse still receiving UI, reports neither",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1516, // spouse UI: $350/wk × 4.333
    whyUnreported: "Applicant's UI ended so they say '$0 income' — forgets spouse's active UI",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "HOUSEHOLD_MEMBER_NO_INCOME", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(1000),
      liquidResources: 75,
    },
  },
  {
    id: "UI05",
    name: "Severance pay this month + UI starting next month, reports $0",
    missingIncomeType: "OTHER",
    missingAmount: 3500, // one-time severance, counted in month received
    whyUnreported: "Severance was a 'lump sum, not income' — UI hasn't started yet",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(1100),
      liquidResources: 3500, // severance sitting in bank
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKERS' COMPENSATION / DISABILITY INSURANCE
  // "It's insurance, not income"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI06",
    name: "On workers' comp after injury, reports $0 earned income",
    missingIncomeType: "OTHER",
    missingAmount: 1400, // workers comp ~$350/wk
    whyUnreported: "Thinks workers' comp is 'insurance' not 'income' — it's countable for SNAP",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [],
      medicalExpenses: 100,
      shelterExpense: shelter(800),
      liquidResources: 300,
    },
    applicantIsDisabled: true,
  },
  {
    id: "UI07",
    name: "Short-term disability from employer, only reports SSI",
    missingIncomeType: "OTHER",
    missingAmount: 900, // private STD ~60% of $1500 salary
    whyUnreported: "Considers private disability insurance separate from 'government benefits'",
    expectedFlags: ["SHELTER_UTILITY_OVERLAP"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      medicalExpenses: 200,
      shelterExpense: shelter(600),
      liquidResources: 150,
    },
    applicantIsDisabled: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // REGULAR CASH / INFORMAL INCOME
  // "That's not really income"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI08",
    name: "Mom sends $500/mo regularly, not reported as income",
    missingIncomeType: "OTHER",
    missingAmount: 500,
    whyUnreported: "Regular cash gifts from family are countable income — applicant thinks 'gifts don't count'",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 250)],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 100,
    },
  },
  {
    id: "UI09",
    name: "Rents spare room for $400/mo, not reported",
    missingIncomeType: "OTHER",
    missingAmount: 400,
    whyUnreported: "Subletting income / boarder payments count as unearned income for SNAP",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 1100)],
      shelterExpense: shelter(0, "HEATING_COOLING", { propertyTax: 120, insurance: 80 }),
      liquidResources: 500,
    },
    applicantIsElderly: true,
  },
  {
    id: "UI10",
    name: "Watches sister's kids for $600/mo cash, considers herself 'unemployed'",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 600,
    whyUnreported: "Informal childcare for cash is self-employment income — 'it's just helping family'",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(750),
      liquidResources: 50,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ALIMONY / SPOUSAL SUPPORT / TANF
  // "That's a different program / that's personal"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI11",
    name: "Receives $600/mo alimony, only reports employment",
    missingIncomeType: "OTHER",
    missingAmount: 600,
    whyUnreported: "Thinks alimony is 'between me and my ex' — it counts as unearned income",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 550)],
      shelterExpense: shelter(900),
      liquidResources: 200,
    },
  },
  {
    id: "UI12",
    name: "Already receives TANF $280/mo, doesn't list it on SNAP application",
    missingIncomeType: "OTHER",
    missingAmount: 280,
    whyUnreported: "Thinks TANF and SNAP are 'the same system' — TANF counts as unearned income for SNAP",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(650),
      liquidResources: 30,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ODD JOBS / DAY LABOR / GIG
  // "It's not a real job"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI13",
    name: "Does day labor 2-3 days/week, ~$800/mo cash, reports $0",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 800,
    whyUnreported: "Irregular cash work with no W-2 — 'I don't have a job'",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(550, "BASIC"),
      liquidResources: 100,
    },
  },
  {
    id: "UI14",
    name: "DoorDash + UI, reports neither — 'I'm between jobs'",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 1800, // UI $280/wk + gig ~$500/mo
    whyUnreported: "UI is 'temporary' and gig work is 'not a real job' — both count",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(850),
      liquidResources: 75,
    },
  },
  {
    id: "UI15",
    name: "Braids hair for cash ~$1000/mo, receives child support, only reports CS",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 1000,
    whyUnreported: "Cash-based services without a business license — 'I'm not self-employed'",
    expectedFlags: ["INCOME_EXPENSE_MISMATCH"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      // Only reports child support
      incomeSources: [income("CHILD_SUPPORT", "MONTHLY", 350)],
      shelterExpense: { ...shelter(800), totalShelterCost: 1214 },
      liquidResources: 150,
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // UI COMBINATION SCENARIOS
  // The most frequent real-world pattern: UI + another income source,
  // where the applicant reports one but not the other (or neither).
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "UI16",
    name: "Early retiree (62) drawing SS $1450/mo + UI $300/wk from last job — only reports SS",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1300, // 300 × 4.333
    whyUnreported: "Just retired and got laid off from final job — 'I'm retired now, SS is my income'",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 1450)],
      shelterExpense: shelter(950),
      liquidResources: 1200,
    },
    applicantIsElderly: true,
  },
  {
    id: "UI17",
    name: "Tapping 401k $2000/mo + UI $280/wk, reports $0 — 'living off savings'",
    missingIncomeType: "OTHER",
    missingAmount: 3213, // 401k $2000 + UI $1213
    whyUnreported: "401k withdrawals are 'my own savings, not income' — UI is 'temporary'",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(1000),
      liquidResources: 8000,
    },
  },
  {
    id: "UI18",
    name: "Spouse draws SS $1650/mo at 63, applicant on UI $320/wk — reports neither",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 3036, // SS $1650 + UI $1386
    whyUnreported: "Spouse 'is retired' and applicant 'is unemployed' — neither considers their payments as income",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "HOUSEHOLD_MEMBER_NO_INCOME", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "60+", { elderly: true }),
      ],
      incomeSources: [],
      shelterExpense: shelter(1200),
      liquidResources: 500,
    },
  },
  {
    id: "UI19",
    name: "Military pension $1800/mo + UI from civilian job $250/wk — only reports pension",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1083, // 250 × 4.333
    whyUnreported: "Pension is 'my retirement' — UI from short civilian job feels separate",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("PENSION", "MONTHLY", 1800)],
      shelterExpense: shelter(1100),
      liquidResources: 400,
    },
  },
  {
    id: "UI20",
    name: "VA disability $1200/mo + UI $300/wk, spouse also works part-time unreported — only reports VA",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1300, // UI only; spouse's income is separate missing amount
    whyUnreported: "VA is 'for my service-connected disability' — doesn't think UI from warehouse job counts",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("VA_BENEFITS", "MONTHLY", 1200)],
      shelterExpense: shelter(850),
      medicalExpenses: 75,
      liquidResources: 250,
    },
    applicantIsDisabled: true,
  },
  {
    id: "UI21",
    name: "SSDI $1450/mo + partial UI $180/wk from old part-time job — only reports SSDI",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 780, // 180 × 4.333
    whyUnreported: "On disability, had a part-time job that ended — 'didn't think UI counted since I'm on disability'",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSDI", "MONTHLY", 1450)],
      shelterExpense: shelter(600, "BASIC"),
      medicalExpenses: 150,
      liquidResources: 200,
    },
    applicantIsDisabled: true,
  },
  {
    id: "UI22",
    name: "Child support $450/mo + UI $320/wk, single mom — only reports child support",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1386, // 320 × 4.333
    whyUnreported: "Child support is 'for the kids' and UI is 'temporary while I job search' — both count",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [income("CHILD_SUPPORT", "MONTHLY", 450)],
      shelterExpense: shelter(850),
      liquidResources: 100,
    },
  },
  {
    id: "UI23",
    name: "Rental income $900/mo from inherited duplex + UI $280/wk — reports neither",
    missingIncomeType: "OTHER",
    missingAmount: 2113, // rental $900 + UI $1213
    whyUnreported: "Rental property 'pays for itself' — UI is temporary. Neither feels like 'my income'",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 2500,
    },
  },
  {
    id: "UI24",
    name: "SS $1800/mo + 401k withdrawals $1500/mo — only reports SS, '401k is savings not income'",
    missingIncomeType: "OTHER",
    missingAmount: 1500, // 401k monthly withdrawal
    whyUnreported: "Already paid taxes on 401k contributions — 'it's my money, not new income'",
    expectedFlags: ["PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 1800)],
      shelterExpense: shelter(0, "HEATING_COOLING", { propertyTax: 200, insurance: 100 }),
      liquidResources: 15000,
    },
    applicantIsElderly: true,
  },
  {
    id: "UI25",
    name: "Part-time cashier $200/wk + UI $300/wk + sells tamales ~$400/mo — only reports the cashier job",
    missingIncomeType: "UNEMPLOYMENT",
    missingAmount: 1700, // UI $1300 + tamales $400
    whyUnreported: "Cashier job is 'my only real job' — UI is temporary, tamales are 'just a side thing'",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 200)],
      shelterExpense: shelter(800),
      liquidResources: 150,
    },
  },
];

module.exports = { UNREPORTED_INCOME_PERSONAS };
