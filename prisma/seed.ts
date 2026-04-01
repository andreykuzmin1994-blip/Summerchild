import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Cushion Gov database...");

  // --- States (23 states) ---
  const states = [
    { code: "GA", name: "Georgia", population: 10912876, hasIncomeTax: true },
    { code: "AL", name: "Alabama", population: 5024279, hasIncomeTax: true },
    { code: "AZ", name: "Arizona", population: 7151502, hasIncomeTax: true },
    { code: "AR", name: "Arkansas", population: 3011524, hasIncomeTax: true },
    { code: "CA", name: "California", population: 39538223, hasIncomeTax: true },
    { code: "CO", name: "Colorado", population: 5773714, hasIncomeTax: true },
    { code: "FL", name: "Florida", population: 21538187, hasIncomeTax: false },
    { code: "IL", name: "Illinois", population: 12812508, hasIncomeTax: true },
    { code: "IN", name: "Indiana", population: 6732219, hasIncomeTax: true },
    { code: "KY", name: "Kentucky", population: 4505836, hasIncomeTax: true },
    { code: "LA", name: "Louisiana", population: 4657757, hasIncomeTax: true },
    { code: "MI", name: "Michigan", population: 10037261, hasIncomeTax: true },
    { code: "MS", name: "Mississippi", population: 2961279, hasIncomeTax: true },
    { code: "MO", name: "Missouri", population: 6154913, hasIncomeTax: true },
    { code: "NC", name: "North Carolina", population: 10439388, hasIncomeTax: true },
    { code: "OH", name: "Ohio", population: 11799448, hasIncomeTax: true },
    { code: "PA", name: "Pennsylvania", population: 13002700, hasIncomeTax: true },
    { code: "SC", name: "South Carolina", population: 5118425, hasIncomeTax: true },
    { code: "TN", name: "Tennessee", population: 6910840, hasIncomeTax: false },
    { code: "TX", name: "Texas", population: 29145505, hasIncomeTax: false },
    { code: "VA", name: "Virginia", population: 8631393, hasIncomeTax: true },
    { code: "WI", name: "Wisconsin", population: 5893718, hasIncomeTax: true },
    { code: "WV", name: "West Virginia", population: 1793716, hasIncomeTax: true },
  ];

  for (const state of states) {
    await prisma.state.upsert({
      where: { code: state.code },
      update: state,
      create: state,
    });
  }
  console.log(`  ✓ ${states.length} states seeded`);

  // --- SNAP Config (Georgia focus) ---
  const snapConfigs = [
    { stateCode: "GA", bbce: true, grossIncomePct: 130, assetLimit: null, assetLimitElderly: null, localProgramName: "Food Stamps (Georgia Gateway)", notes: "GA uses standard 130% gross income test under BBCE; no asset test" },
    { stateCode: "FL", bbce: true, grossIncomePct: 200, assetLimit: null, assetLimitElderly: null, localProgramName: "SNAP (ACCESS Florida)" },
    { stateCode: "TX", bbce: true, grossIncomePct: 165, assetLimit: null, assetLimitElderly: null, localProgramName: "SNAP (Your Texas Benefits)" },
    { stateCode: "CA", bbce: true, grossIncomePct: 200, assetLimit: null, assetLimitElderly: null, localProgramName: "CalFresh" },
    { stateCode: "NC", bbce: true, grossIncomePct: 200, assetLimit: null, assetLimitElderly: null, localProgramName: "Food and Nutrition Services (ePASS)" },
  ];

  for (const config of snapConfigs) {
    await prisma.snapConfig.upsert({
      where: { stateCode: config.stateCode },
      update: config,
      create: config,
    });
  }
  console.log(`  ✓ ${snapConfigs.length} SNAP configs seeded`);

  // --- Federal SNAP Data FY2026 ---
  const fy2026SnapData = [
    { fiscalYear: 2026, householdSize: 1, grossIncomeLimit: 1632, netIncomeLimit: 1255, maxAllotment: 292, standardDeduction: 209 },
    { fiscalYear: 2026, householdSize: 2, grossIncomeLimit: 2198, netIncomeLimit: 1691, maxAllotment: 536, standardDeduction: 209 },
    { fiscalYear: 2026, householdSize: 3, grossIncomeLimit: 2764, netIncomeLimit: 2127, maxAllotment: 768, standardDeduction: 209 },
    { fiscalYear: 2026, householdSize: 4, grossIncomeLimit: 3330, netIncomeLimit: 2563, maxAllotment: 975, standardDeduction: 223 },
    { fiscalYear: 2026, householdSize: 5, grossIncomeLimit: 3896, netIncomeLimit: 2999, maxAllotment: 1158, standardDeduction: 261 },
    { fiscalYear: 2026, householdSize: 6, grossIncomeLimit: 4462, netIncomeLimit: 3435, maxAllotment: 1390, standardDeduction: 299 },
    { fiscalYear: 2026, householdSize: 7, grossIncomeLimit: 5028, netIncomeLimit: 3871, maxAllotment: 1536, standardDeduction: 299 },
    { fiscalYear: 2026, householdSize: 8, grossIncomeLimit: 5594, netIncomeLimit: 4307, maxAllotment: 1756, standardDeduction: 299 },
  ];

  for (const data of fy2026SnapData) {
    await prisma.federalSnapData.upsert({
      where: { fiscalYear_householdSize: { fiscalYear: data.fiscalYear, householdSize: data.householdSize } },
      update: data,
      create: data,
    });
  }
  console.log(`  ✓ ${fy2026SnapData.length} FY2026 SNAP data rows seeded`);

  // --- Federal Poverty Levels 2026 ---
  const fplData = [
    { year: 2026, householdSize: 1, annualAmount: 15060, context: "BENEFITS" },
    { year: 2026, householdSize: 2, annualAmount: 20280, context: "BENEFITS" },
    { year: 2026, householdSize: 3, annualAmount: 25500, context: "BENEFITS" },
    { year: 2026, householdSize: 4, annualAmount: 30720, context: "BENEFITS" },
    { year: 2026, householdSize: 5, annualAmount: 35940, context: "BENEFITS" },
    { year: 2026, householdSize: 6, annualAmount: 41160, context: "BENEFITS" },
    { year: 2026, householdSize: 7, annualAmount: 46380, context: "BENEFITS" },
    { year: 2026, householdSize: 8, annualAmount: 51600, context: "BENEFITS" },
    { year: 2026, householdSize: 1, annualAmount: 15060, context: "MARKETPLACE" },
    { year: 2026, householdSize: 2, annualAmount: 20280, context: "MARKETPLACE" },
    { year: 2026, householdSize: 3, annualAmount: 25500, context: "MARKETPLACE" },
    { year: 2026, householdSize: 4, annualAmount: 30720, context: "MARKETPLACE" },
  ];

  for (const fpl of fplData) {
    await prisma.federalPovertyLevel.upsert({
      where: { year_householdSize_context: { year: fpl.year, householdSize: fpl.householdSize, context: fpl.context } },
      update: fpl,
      create: fpl,
    });
  }
  console.log(`  ✓ ${fplData.length} FPL rows seeded`);

  // --- OBBBA Provisions (P.L. 119-21) ---
  const obbbaProvisions = [
    {
      provisionName: "SNAP Time Limit Expansion",
      description: "Expands ABAWD time limits to adults aged 18-54 without dependents. States may not waive.",
      effectiveDate: new Date("2025-11-01"),
      affectedPrograms: ["SNAP"],
      exemptions: "Pregnant individuals, individuals with disabilities, veterans, homeless individuals",
      notes: "Georgia implementation date aligned with federal effective date",
    },
    {
      provisionName: "Medicaid Work Requirements",
      description: "Requires work, education, or community service (80 hrs/month) for Medicaid expansion adults aged 19-64.",
      effectiveDate: new Date("2026-12-31"),
      affectedPrograms: ["MEDICAID"],
      exemptions: "Pregnant, disabled, caretaker of child under 6, full-time students, tribal members",
      notes: "States have until Dec 2026 to implement; GA may implement earlier",
    },
    {
      provisionName: "SNAP Standard Deduction Freeze",
      description: "Standard deductions frozen at FY2026 levels through FY2030.",
      effectiveDate: new Date("2025-10-01"),
      affectedPrograms: ["SNAP"],
      notes: "No annual inflation adjustments to standard deduction until FY2031",
    },
  ];

  for (const provision of obbbaProvisions) {
    await prisma.obbbaProvision.create({ data: provision });
  }
  console.log(`  ✓ ${obbbaProvisions.length} OBBBA provisions seeded`);

  // --- Default County (DeKalb County, GA for pilot) ---
  await prisma.county.upsert({
    where: { id: "dekalb-ga-001" },
    update: {},
    create: {
      id: "dekalb-ga-001",
      stateCode: "GA",
      name: "DeKalb County",
      dfcsOffice: "DeKalb County DFCS - Memorial Drive",
    },
  });
  console.log("  ✓ DeKalb County seeded");

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
