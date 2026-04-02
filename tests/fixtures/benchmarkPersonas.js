/**
 * 30 Realistic SNAP Applicant Benchmark Personas
 *
 * Based on USDA SNAP participation data, Census ACS, and Georgia DFCS demographics:
 *  - 44% of SNAP households include children (mostly single-parent)
 *  - 20% are elderly (60+) households
 *  - 27% include a non-elderly disabled member
 *  - ~30% have at least one employed member ("working poor")
 *  - Georgia median rent: $700-$1200 metro, $450-$800 rural
 *  - Federal SSI (2025): $943/month; avg SSDI: ~$1,500; avg SS retirement: ~$1,200
 *
 * Each persona is a valid intake object for calculateFullEligibility().
 * Organized by archetype to mirror real county DFCS caseload distribution.
 */

// ─── Helper: build household member ────────────────────────────────────────
function member(id, name, relationship, age, opts = {}) {
  return {
    id,
    displayName: name,
    relationshipToApplicant: relationship,
    ageRange: age,
    inSnapHousehold: true,
    isElderly: opts.elderly || false,
    isDisabled: opts.disabled || false,
    hasEarnedIncome: opts.earned || false,
    hasUnearnedIncome: opts.unearned || false,
  };
}

// ─── Helper: build income source ───────────────────────────────────────────
function income(type, frequency, amount, opts = {}) {
  const src = { incomeType: type, payFrequency: frequency, grossAmountPerPeriod: amount };
  if (opts.memberId) src.householdMemberId = opts.memberId;
  if (type === "SELF_EMPLOYMENT") {
    src.selfEmploymentGross = opts.selfEmploymentGross || amount;
    src.selfEmploymentExpenses = opts.selfEmploymentExpenses || 0;
  }
  return src;
}

// ─── Helper: build shelter expense ─────────────────────────────────────────
function shelter(rent, utilityType = "HEATING_COOLING", opts = {}) {
  const sua = { HEATING_COOLING: 414, BASIC: 284, PHONE_ONLY: 55, NONE: 0 };
  return {
    rentOrMortgage: rent,
    propertyTax: opts.propertyTax || 0,
    homeownersInsurance: opts.insurance || 0,
    standardUtilityAllowance: sua[utilityType],
    utilityType,
  };
}

const PERSONAS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // SINGLE PARENTS WITH CHILDREN (Personas 1–8)  ~44% of SNAP caseload
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "P01",
    name: "Single mom, 2 kids, part-time retail (Fulton Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 620)],
      dependentCareExpense: 400,
      shelterExpense: shelter(950),
      liquidResources: 200,
    },
  },
  {
    id: "P02",
    name: "Single mom, 1 toddler, minimum wage full-time (DeKalb Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 580)],
      dependentCareExpense: 650,
      shelterExpense: shelter(875),
      liquidResources: 150,
    },
  },
  {
    id: "P03",
    name: "Single dad, 3 kids, warehouse worker (Chatham Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 520)],
      dependentCareExpense: 200,
      shelterExpense: shelter(1050),
      liquidResources: 75,
    },
  },
  {
    id: "P04",
    name: "Single mom, 1 child, recently unemployed (Bibb Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [],
      shelterExpense: shelter(650),
      liquidResources: 80,
    },
  },
  {
    id: "P05",
    name: "Single mom, 4 kids, two jobs (Gwinnett Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
        member("c4", "Child D", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 700),
        income("EMPLOYMENT", "WEEKLY", 180),
      ],
      dependentCareExpense: 500,
      shelterExpense: shelter(1200),
      liquidResources: 100,
    },
  },
  {
    id: "P06",
    name: "Married couple, 2 kids, one working min wage (Richmond Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39", { earned: false }),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 580)],
      dependentCareExpense: 0,
      shelterExpense: shelter(750),
      liquidResources: 200,
    },
  },
  {
    id: "P07",
    name: "Single mom, teen + baby, receiving child support (Muscogee Co.)",
    intake: {
      householdMembers: [
        member("c1", "Teen", "child", "under 18"),
        member("c2", "Baby", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 500),
        income("CHILD_SUPPORT", "MONTHLY", 350),
      ],
      dependentCareExpense: 300,
      shelterExpense: shelter(700),
      liquidResources: 50,
    },
  },
  {
    id: "P08",
    name: "Single mom, disabled child, SSI for child (Clarke Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18", { disabled: true, unearned: true }),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 480),
        income("SSI", "MONTHLY", 943, { memberId: "c1" }),
      ],
      medicalExpenses: 120,
      shelterExpense: shelter(800),
      liquidResources: 300,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ELDERLY HOUSEHOLDS (Personas 9–14)  ~20% of SNAP caseload
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "P09",
    name: "Elderly woman living alone, SS only (Dougherty Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 950)],
      medicalExpenses: 180,
      shelterExpense: shelter(500, "HEATING_COOLING"),
      liquidResources: 400,
    },
    applicantIsElderly: true,
  },
  {
    id: "P10",
    name: "Elderly couple, both on SS, high medical (Houston Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "60+", { elderly: true, unearned: true }),
      ],
      incomeSources: [
        income("SOCIAL_SECURITY", "MONTHLY", 1100),
        income("SOCIAL_SECURITY", "MONTHLY", 850, { memberId: "s1" }),
      ],
      medicalExpenses: 450,
      shelterExpense: shelter(600, "HEATING_COOLING", { propertyTax: 80, insurance: 45 }),
      liquidResources: 1500,
    },
  },
  {
    id: "P11",
    name: "Elderly man, SSI only, renting room (Whitfield Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      medicalExpenses: 60,
      shelterExpense: shelter(350, "BASIC"),
      liquidResources: 50,
    },
    applicantIsElderly: true,
  },
  {
    id: "P12",
    name: "Elderly widow, pension + SS, homeowner (Cobb Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("SOCIAL_SECURITY", "MONTHLY", 1200),
        income("PENSION", "MONTHLY", 300),
      ],
      medicalExpenses: 280,
      shelterExpense: shelter(0, "HEATING_COOLING", { propertyTax: 150, insurance: 90 }),
      liquidResources: 2000,
    },
    applicantIsElderly: true,
  },
  {
    id: "P13",
    name: "Elderly + disabled, SS + SSDI (Lowndes Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("SOCIAL_SECURITY", "MONTHLY", 800),
        income("SSDI", "MONTHLY", 600),
      ],
      medicalExpenses: 350,
      shelterExpense: shelter(575, "HEATING_COOLING"),
      liquidResources: 200,
    },
    applicantIsElderly: true,
    applicantIsDisabled: true,
  },
  {
    id: "P14",
    name: "Elderly grandparent raising grandchild, SS only (Troup Co.)",
    intake: {
      householdMembers: [
        member("c1", "Grandchild", "grandchild", "under 18"),
      ],
      incomeSources: [income("SOCIAL_SECURITY", "MONTHLY", 1050)],
      medicalExpenses: 90,
      shelterExpense: shelter(650, "HEATING_COOLING"),
      liquidResources: 300,
    },
    applicantIsElderly: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DISABLED (NON-ELDERLY) HOUSEHOLDS (Personas 15–20)  ~27% of caseload
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "P15",
    name: "Disabled adult, SSI only (Floyd Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [income("SSI", "MONTHLY", 943)],
      medicalExpenses: 75,
      shelterExpense: shelter(475, "BASIC"),
      liquidResources: 50,
    },
    applicantIsDisabled: true,
  },
  {
    id: "P16",
    name: "Disabled adult + spouse working part-time (Hall Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "40-49", { earned: true }),
      ],
      incomeSources: [
        income("SSDI", "MONTHLY", 1200),
        income("EMPLOYMENT", "BIWEEKLY", 450, { memberId: "s1" }),
      ],
      medicalExpenses: 200,
      shelterExpense: shelter(850, "HEATING_COOLING"),
      liquidResources: 400,
    },
    applicantIsDisabled: true,
  },
  {
    id: "P17",
    name: "Disabled single parent, SSDI + 1 child (Chatham Co.)",
    intake: {
      householdMembers: [
        member("c1", "Child A", "child", "under 18"),
      ],
      incomeSources: [income("SSDI", "MONTHLY", 1100)],
      medicalExpenses: 150,
      shelterExpense: shelter(750, "HEATING_COOLING"),
      liquidResources: 100,
    },
    applicantIsDisabled: true,
  },
  {
    id: "P18",
    name: "Disabled veteran, VA + SSDI (Columbia Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("VA_BENEFITS", "MONTHLY", 400),
        income("SSDI", "MONTHLY", 1500),
      ],
      medicalExpenses: 300,
      shelterExpense: shelter(700, "HEATING_COOLING"),
      liquidResources: 500,
    },
    applicantIsDisabled: true,
  },
  {
    id: "P19",
    name: "Disabled adult + elderly parent in home (Carroll Co.)",
    intake: {
      householdMembers: [
        member("p1", "Parent", "parent", "60+", { elderly: true, unearned: true }),
      ],
      incomeSources: [
        income("SSDI", "MONTHLY", 1000),
        income("SOCIAL_SECURITY", "MONTHLY", 1100, { memberId: "p1" }),
      ],
      medicalExpenses: 275,
      shelterExpense: shelter(900, "HEATING_COOLING", { propertyTax: 60 }),
      liquidResources: 600,
    },
    applicantIsDisabled: true,
  },
  {
    id: "P20",
    name: "Disabled adult, part-time work + SSDI (Bartow Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("SSDI", "MONTHLY", 900),
        income("EMPLOYMENT", "WEEKLY", 120),
      ],
      medicalExpenses: 100,
      shelterExpense: shelter(550, "BASIC"),
      liquidResources: 150,
    },
    applicantIsDisabled: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKING POOR / CHILDLESS ADULTS (Personas 21–25)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "P21",
    name: "Single adult, fast food worker (Clayton Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "BIWEEKLY", 520)],
      shelterExpense: shelter(700, "BASIC"),
      liquidResources: 75,
    },
  },
  {
    id: "P22",
    name: "Single adult, gig worker / self-employed (Fulton Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [
        income("SELF_EMPLOYMENT", "MONTHLY", 2200, {
          selfEmploymentGross: 2200,
          selfEmploymentExpenses: 700,
        }),
      ],
      shelterExpense: shelter(900, "BASIC"),
      liquidResources: 100,
    },
  },
  {
    id: "P23",
    name: "Married couple, both part-time, no kids (Bibb Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "20-29", { earned: true }),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 480),
        income("EMPLOYMENT", "WEEKLY", 200, { memberId: "s1" }),
      ],
      shelterExpense: shelter(650, "BASIC"),
      liquidResources: 100,
    },
  },
  {
    id: "P24",
    name: "Single adult, recently laid off, zero income (Gwinnett Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [],
      shelterExpense: shelter(800, "HEATING_COOLING"),
      liquidResources: 60,
    },
  },
  {
    id: "P25",
    name: "Single adult, seasonal farm worker (Colquitt Co.)",
    intake: {
      householdMembers: [],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 350)],
      shelterExpense: shelter(400, "BASIC"),
      liquidResources: 50,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-GENERATIONAL / COMPLEX HOUSEHOLDS (Personas 26–30)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "P26",
    name: "3-gen household: grandparent + parent + 2 kids (DeKalb Co.)",
    intake: {
      householdMembers: [
        member("p1", "Grandparent", "parent", "60+", { elderly: true, unearned: true }),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 680),
        income("SOCIAL_SECURITY", "MONTHLY", 1000, { memberId: "p1" }),
      ],
      dependentCareExpense: 300,
      medicalExpenses: 100,
      shelterExpense: shelter(1100, "HEATING_COOLING"),
      liquidResources: 250,
    },
  },
  {
    id: "P27",
    name: "Mother + adult disabled son + child (Muscogee Co.)",
    intake: {
      householdMembers: [
        member("s1", "Adult Son", "child", "20-29", { disabled: true, unearned: true }),
        member("c1", "Grandchild", "grandchild", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 550),
        income("SSI", "MONTHLY", 943, { memberId: "s1" }),
      ],
      medicalExpenses: 150,
      shelterExpense: shelter(800, "HEATING_COOLING"),
      liquidResources: 150,
    },
  },
  {
    id: "P28",
    name: "Blended family: couple + his 2 kids + her 1 kid, child support paid (Cobb Co.)",
    intake: {
      householdMembers: [
        member("s1", "Partner", "spouse", "30-39", { earned: true }),
        member("c1", "His Child A", "child", "under 18"),
        member("c2", "His Child B", "child", "under 18"),
        member("c3", "Her Child", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 750),
        income("EMPLOYMENT", "BIWEEKLY", 600, { memberId: "s1" }),
      ],
      childSupportPaid: 400,
      dependentCareExpense: 350,
      shelterExpense: shelter(1150, "HEATING_COOLING"),
      liquidResources: 200,
    },
  },
  {
    id: "P29",
    name: "Immigrant family, 6 members, single earner (Gwinnett Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39"),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
        member("c4", "Child D", "child", "under 18"),
      ],
      incomeSources: [income("EMPLOYMENT", "WEEKLY", 480)],
      shelterExpense: shelter(1100, "HEATING_COOLING"),
      liquidResources: 100,
    },
  },
  {
    id: "P30",
    name: "Large family, 8 members, mixed income (Clarke Co.)",
    intake: {
      householdMembers: [
        member("s1", "Spouse", "spouse", "30-39", { earned: true }),
        member("p1", "Parent-in-law", "parent", "60+", { elderly: true, unearned: true }),
        member("c1", "Child A", "child", "under 18"),
        member("c2", "Child B", "child", "under 18"),
        member("c3", "Child C", "child", "under 18"),
        member("c4", "Child D", "child", "under 18"),
        member("c5", "Child E", "child", "under 18"),
      ],
      incomeSources: [
        income("EMPLOYMENT", "BIWEEKLY", 800),
        income("EMPLOYMENT", "WEEKLY", 250, { memberId: "s1" }),
        income("SOCIAL_SECURITY", "MONTHLY", 900, { memberId: "p1" }),
      ],
      dependentCareExpense: 200,
      medicalExpenses: 80,
      shelterExpense: shelter(1300, "HEATING_COOLING", { propertyTax: 100 }),
      liquidResources: 350,
    },
  },
];

module.exports = { PERSONAS, member, income, shelter };
