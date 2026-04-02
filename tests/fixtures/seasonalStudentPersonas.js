/**
 * 20 Seasonal Income + Student Eligibility Benchmark Personas
 *
 * Two gap areas in SNAP overpayment detection:
 *
 * SEASONAL INCOME (S01–S10): Applicants in seasonal industries who report
 * income from their slow period instead of a typical month. USDA requires
 * "anticipated monthly income" — not the lowest recent month. Construction,
 * agriculture, food service, landscaping, and tourism are the top seasonal
 * industries in Georgia SNAP cases.
 *
 * STUDENT ELIGIBILITY (ST01–ST10): Household members aged 18–49 enrolled
 * at least half-time in higher education are generally INELIGIBLE for SNAP
 * unless they meet an exemption:
 *   - Working 20+ hours/week
 *   - Participating in federal/state work-study
 *   - Single parent of child under 6 (or under 12 with no childcare)
 *   - Receiving TANF
 *   - Unable to work due to physical/mental disability
 *
 * Most applicants don't know the student rule exists.
 */

const { member, income, shelter } = require("./benchmarkPersonas.js");

const SEASONAL_STUDENT_PERSONAS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // SEASONAL INCOME — reporting the slow month
  // "This is what I make right now"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "S01",
    name: "Construction worker reports $400/mo (winter layoff) — averages $2800/mo Apr–Nov",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 2400, // difference between slow month and typical
    whyUnreported: "Reports current slow-season income, not anticipated average — 'this is what I make now'",
    expectedFlags: ["SEASONAL_INCOME_POSSIBLE"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 100)],
      shelterExpense: shelter(750),
      liquidResources: 200,
    },
  },
  {
    id: "S02",
    name: "Farm worker reports $0 (winter off-season) — earns $3000/mo during harvest Apr–Oct",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 3000,
    whyUnreported: "Genuinely not working right now — but anticipated income should reflect typical year",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(650),
      liquidResources: 100,
    },
  },
  {
    id: "S03",
    name: "Tax preparer reports $200/mo (summer) — earns $5000/mo Jan–Apr",
    category: "seasonal",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 4800,
    whyUnreported: "Self-employed, reports current month — SNAP should use annualized self-employment income",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      // Reports tiny self-employment income from summer side jobs
      incomeSources: [income("SELF_EMPLOYMENT", "MONTHLY", 200, { selfEmploymentGross: 200, selfEmploymentExpenses: 0 })],
      shelterExpense: shelter(900),
      liquidResources: 500,
    },
  },
  {
    id: "S04",
    name: "Landscaper reports $80/wk (winter) — earns $600/wk spring through fall",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 2253, // (600-80) × 4.333
    whyUnreported: "Truthfully reporting current pay — doesn't know SNAP averages seasonal income",
    expectedFlags: ["SEASONAL_INCOME_POSSIBLE"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 80)],
      shelterExpense: shelter(700),
      liquidResources: 50,
    },
  },
  {
    id: "S05",
    name: "Hotel housekeeper reports $450/mo (off-season Jan–Mar) — earns $2200/mo peak season",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 1750,
    whyUnreported: "Resort cuts hours in winter — reports current reduced schedule, not annual average",
    expectedFlags: ["SEASONAL_INCOME_POSSIBLE", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 450)],
      shelterExpense: shelter(600, "BASIC"),
      liquidResources: 75,
    },
  },
  {
    id: "S06",
    name: "School cafeteria worker reports $0 (summer break) — earns $1400/mo during school year",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 1400,
    whyUnreported: "Not working in summer — doesn't report anticipated Sept income or unemployment benefits",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(800),
      liquidResources: 50,
    },
  },
  {
    id: "S07",
    name: "Seasonal retail reports $300/mo (post-holiday) — earns $1800/mo Oct–Dec",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 1500,
    whyUnreported: "Holiday temp job ended, picked up a few shifts — reports current, not seasonal average",
    expectedFlags: ["SEASONAL_INCOME_POSSIBLE"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 300)],
      shelterExpense: shelter(650),
      liquidResources: 150,
    },
  },
  {
    id: "S08",
    name: "Charter fishing crew reports $0 (closed season Feb–Mar) — earns $3500/mo Apr–Jan",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 3500,
    whyUnreported: "Season is closed — 'I literally cannot work right now'",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(900),
      liquidResources: 800,
    },
  },
  {
    id: "S09",
    name: "Snow plow / salt truck operator reports $0 (summer) — earns $2000/mo Nov–Mar",
    category: "seasonal",
    missingIncomeType: "EMPLOYMENT",
    missingAmount: 2000,
    whyUnreported: "Summer is truly off-season — but anticipated income or UI should be reported",
    expectedFlags: ["ZERO_INCOME_WITH_SHELTER", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "HIGH",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
      ],
      incomeSources: [],
      shelterExpense: shelter(850),
      liquidResources: 300,
    },
  },
  {
    id: "S10",
    name: "Food truck owner reports $400/mo (winter) — grosses $3000/mo at summer festivals",
    category: "seasonal",
    missingIncomeType: "SELF_EMPLOYMENT",
    missingAmount: 2600,
    whyUnreported: "Self-employment income should be annualized — winter slump is not 'typical'",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("SELF_EMPLOYMENT", "MONTHLY", 400, { selfEmploymentGross: 800, selfEmploymentExpenses: 400 })],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 200,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // STUDENT ELIGIBILITY — the rule nobody knows about
  // "My kid is 19 and lives with me — of course they're on my SNAP"
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "ST01",
    name: "19-year-old in parents' HH, full-time college, no job — likely ineligible",
    category: "student",
    studentAge: "18-24",
    studentStatus: "full-time, no exemption",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "College Kid", "child", "18-24"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 600)],
      shelterExpense: shelter(800),
      liquidResources: 200,
    },
  },
  {
    id: "ST02",
    name: "22-year-old grad student, TA stipend $800/mo — may qualify if TA is 20+ hrs",
    category: "student",
    studentAge: "22",
    studentStatus: "half-time+, possible work exemption",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        // TA income is on the applicant, not this member — the stipend isn't linked
        member("a1", "Grad Student", "child", "22-24"),
      ],
      incomeSources: [income("EMPLOYMENT", "MONTHLY", 800)],
      shelterExpense: shelter(1100),
      liquidResources: 300,
    },
  },
  {
    id: "ST03",
    name: "20-year-old community college, works 15 hrs/wk fast food — under 20-hr exemption",
    category: "student",
    studentAge: "20",
    studentStatus: "half-time, works < 20 hrs/wk — NO exemption, but has reported income",
    expectedFlags: ["SEASONAL_INCOME_POSSIBLE", "POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "CC Student", "child", "20-24", { earned: true }),
        member("c1", "Sibling", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 650),
        income("EMPLOYMENT", "WEEKLY", 100, { memberId: "a1" }),
      ],
      shelterExpense: shelter(750),
      liquidResources: 100,
    },
  },
  {
    id: "ST04",
    name: "25-year-old single parent back in school, toddler at home — EXEMPT as parent of child < 6",
    category: "student",
    studentAge: "25",
    studentStatus: "half-time+, EXEMPT — single parent of child under 6",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("c1", "Toddler", "child", "under 18"),
      ],
      // No unearned income, only part-time work
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 180)],
      shelterExpense: shelter(700),
      liquidResources: 50,
    },
  },
  {
    id: "ST05",
    name: "19-year-old says 'unemployed' on SNAP app — actually enrolled full-time at university",
    category: "student",
    studentAge: "19",
    studentStatus: "full-time, no exemption, didn't disclose enrollment",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "Student", "child", "18-24"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 580)],
      shelterExpense: shelter(850),
      liquidResources: 100,
    },
  },
  {
    id: "ST06",
    name: "24-year-old online degree student, works full-time $1200/mo — EXEMPT (20+ hrs)",
    category: "student",
    studentAge: "24",
    studentStatus: "half-time online, EXEMPT — works 20+ hours/week",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        // Works full-time but income isn't linked to member
        member("a1", "Working Student", "child", "20-24"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 700)],
      shelterExpense: shelter(900),
      liquidResources: 150,
    },
  },
  {
    id: "ST07",
    name: "18-year-old just graduated HS, starting college in fall — eligible NOW, not in fall",
    category: "student",
    studentAge: "18",
    studentStatus: "not yet enrolled — currently eligible, flagged for future review",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "HS Grad", "child", "18-24"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 350)],
      shelterExpense: shelter(650),
      liquidResources: 75,
    },
  },
  {
    id: "ST08",
    name: "21-year-old dropped out mid-semester — status unclear, needs verification",
    category: "student",
    studentAge: "21",
    studentStatus: "unclear — may still be enrolled on paper even if not attending",
    expectedFlags: ["POSSIBLE_STUDENT_NO_EXEMPTION", "HOUSEHOLD_MEMBER_NO_INCOME"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        member("a1", "Dropout?", "child", "20-24"),
      ],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      shelterExpense: shelter(500, "BASIC"),
      liquidResources: 50,
    },
    applicantIsDisabled: true,
  },
  {
    id: "ST09",
    name: "30-year-old going back to school + receiving UI — student + UI double issue",
    category: "student",
    studentAge: "30",
    studentStatus: "half-time+, no exemption unless UI qualifies as 'job training'",
    // 30-39 age range won't trigger POSSIBLE_STUDENT_NO_EXEMPTION (> 24)
    // But UI is unreported → POSSIBLE_UNREPORTED_BENEFITS fires
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [],
      // Only reports part-time job, not UI
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 150)],
      shelterExpense: shelter(800),
      liquidResources: 200,
    },
  },
  {
    id: "ST10",
    name: "20-year-old in work-study $500/mo + parents' HH — EXEMPT under work-study",
    category: "student",
    studentAge: "20",
    studentStatus: "half-time+, EXEMPT — federal work-study participant",
    expectedFlags: ["POSSIBLE_UNREPORTED_BENEFITS", "PAY_FREQUENCY_SUSPICIOUS"],
    expectedRisk: "MEDIUM",
    intake: {
      householdMembers: [
        // Work-study income linked to member
        member("a1", "Work-Study Student", "child", "20-24", { earned: true }),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 550),
        income("EMPLOYMENT", "MONTHLY", 500, { memberId: "a1" }),
      ],
      shelterExpense: shelter(750),
      liquidResources: 100,
    },
  },
];

module.exports = { SEASONAL_STUDENT_PERSONAS };
