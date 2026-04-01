const { PrismaClient } = require("@prisma/client");
const gaConfig = require("../config/ga-snap-deductions-fy2026.json");

const prisma = new PrismaClient();

// Pay frequency conversion factors to monthly
const FREQUENCY_MULTIPLIERS = {
  WEEKLY: 4.333,
  BIWEEKLY: 2.167,
  SEMI_MONTHLY: 2,
  MONTHLY: 1,
};

/**
 * Read SNAP limits from the FederalSnapData table for a given fiscal year and household size.
 * For household sizes > 8, extrapolates using per-member increments.
 */
async function getSnapLimits(fiscalYear, householdSize) {
  const cappedSize = Math.min(householdSize, 8);
  const data = await prisma.federalSnapData.findUnique({
    where: { fiscalYear_householdSize: { fiscalYear, householdSize: cappedSize } },
  });

  if (!data) {
    throw new Error(`No FederalSnapData found for FY${fiscalYear} HH size ${cappedSize}`);
  }

  const extraMembers = Math.max(0, householdSize - 8);
  return {
    grossIncomeLimit: data.grossIncomeLimit + extraMembers * gaConfig.additionalMemberGrossIncomeIncrement,
    netIncomeLimit: data.netIncomeLimit + extraMembers * gaConfig.additionalMemberNetIncomeIncrement,
    maxAllotment: data.maxAllotment + extraMembers * gaConfig.additionalMemberAllotmentIncrement,
    standardDeduction: data.standardDeduction,
  };
}

/**
 * Read state-specific SNAP/BBCE config from the SnapConfig table.
 */
async function getStateSnapConfig(stateCode) {
  const config = await prisma.snapConfig.findUnique({
    where: { stateCode },
  });

  if (!config) {
    throw new Error(`No SnapConfig found for state ${stateCode}`);
  }

  return {
    hasBBCE: config.bbce,
    grossIncomePercent: config.grossIncomePct,
    hasAssetTest: config.assetLimit !== null,
    assetLimit: config.assetLimit,
  };
}

/**
 * Convert an income source's per-period amount to a SNAP monthly amount.
 * For self-employment: uses whichever method produces lower countable income.
 */
function calculateMonthlyIncome(incomeSource) {
  if (incomeSource.incomeType === "SELF_EMPLOYMENT") {
    const gross = incomeSource.selfEmploymentGross || incomeSource.grossAmountPerPeriod;
    const expenses = incomeSource.selfEmploymentExpenses || 0;

    const itemizedNet = gross - expenses;
    const standardNet = gross * (1 - gaConfig.selfEmploymentStandardDeductionRate);

    // Use whichever method produces lower countable income (more favorable to applicant)
    const net = Math.min(itemizedNet, standardNet);
    return Math.max(0, net);
  }

  const multiplier = FREQUENCY_MULTIPLIERS[incomeSource.payFrequency];
  if (!multiplier) {
    throw new Error(`Unknown pay frequency: ${incomeSource.payFrequency}`);
  }

  return Math.round(incomeSource.grossAmountPerPeriod * multiplier * 100) / 100;
}

/**
 * Sum all SNAP monthly amounts for members in the SNAP household.
 */
function calculateHouseholdGrossIncome(incomeSources) {
  return incomeSources.reduce((sum, source) => {
    const monthly = source.snapMonthlyAmount ?? calculateMonthlyIncome(source);
    return sum + monthly;
  }, 0);
}

/**
 * Determine if income source is earned (employment/self-employment).
 */
function isEarnedIncome(incomeType) {
  return incomeType === "EMPLOYMENT" || incomeType === "SELF_EMPLOYMENT";
}

/**
 * Full SNAP deduction calculation following the federal methodology:
 * 1. Standard deduction
 * 2. 20% earned income deduction
 * 3. Dependent care
 * 4. Medical expenses for elderly/disabled
 * 5. Child support paid
 * 6. Shelter excess (capped unless elderly/disabled in household)
 */
async function calculateDeductions(intake, fiscalYear = 2026) {
  const householdSize = (intake.householdMembers || []).filter((m) => m.inSnapHousehold).length + 1; // +1 for applicant
  const limits = await getSnapLimits(fiscalYear, householdSize);

  const hasElderlyOrDisabled =
    (intake.householdMembers || []).some((m) => m.isElderly || m.isDisabled);

  const incomeSources = intake.incomeSources || [];
  const grossIncome = calculateHouseholdGrossIncome(incomeSources);

  const deductions = [];

  // Step 1: Standard deduction by household size
  const standardDeduction = limits.standardDeduction;
  deductions.push({
    type: "STANDARD",
    amount: standardDeduction,
    notes: `Standard deduction for household size ${householdSize}: $${standardDeduction}`,
  });

  // Step 2: 20% earned income deduction
  const totalEarned = incomeSources
    .filter((s) => isEarnedIncome(s.incomeType))
    .reduce((sum, s) => sum + (s.snapMonthlyAmount ?? calculateMonthlyIncome(s)), 0);

  const earnedIncomeDeduction = Math.round(totalEarned * gaConfig.earnedIncomeDeductionRate * 100) / 100;
  if (earnedIncomeDeduction > 0) {
    deductions.push({
      type: "EARNED_INCOME_20PCT",
      amount: earnedIncomeDeduction,
      notes: `20% of earned income ($${totalEarned.toFixed(2)}): $${earnedIncomeDeduction}`,
    });
  }

  // Step 3: Dependent care deduction
  const dependentCare = intake.dependentCareExpense || 0;
  if (dependentCare > 0) {
    deductions.push({
      type: "DEPENDENT_CARE",
      amount: dependentCare,
      notes: `Dependent care expense: $${dependentCare}`,
    });
  }

  // Step 4: Medical expenses for elderly/disabled (over $35 threshold)
  const medicalExpenses = intake.medicalExpenses || 0;
  let medicalDeduction = 0;
  if (hasElderlyOrDisabled && medicalExpenses > gaConfig.medicalDeductionThreshold) {
    // Use standard medical deduction if over threshold, or actual if itemizing
    medicalDeduction = Math.max(
      gaConfig.standardMedicalDeduction,
      medicalExpenses - gaConfig.medicalDeductionThreshold
    );
    deductions.push({
      type: "MEDICAL",
      amount: medicalDeduction,
      notes: `Medical deduction for elderly/disabled (expenses: $${medicalExpenses}): $${medicalDeduction}`,
    });
  }

  // Step 5: Child support paid
  const childSupportPaid = intake.childSupportPaid || 0;
  if (childSupportPaid > 0) {
    deductions.push({
      type: "CHILD_SUPPORT_PAID",
      amount: childSupportPaid,
      notes: `Child support paid: $${childSupportPaid}`,
    });
  }

  // Step 6: Calculate remaining income (gross - steps 1-5)
  const preDeductions = standardDeduction + earnedIncomeDeduction + dependentCare + medicalDeduction + childSupportPaid;
  const remainingIncome = Math.max(0, grossIncome - preDeductions);

  // Step 7: Shelter excess deduction
  const shelter = intake.shelterExpense;
  let shelterDeduction = 0;
  if (shelter) {
    const totalShelterCost = shelter.totalShelterCost || (
      (shelter.rentOrMortgage || 0) +
      (shelter.propertyTax || 0) +
      (shelter.homeownersInsurance || 0) +
      (shelter.standardUtilityAllowance || 0)
    );
    const halfRemaining = remainingIncome * 0.5;
    const excessShelter = Math.max(0, totalShelterCost - halfRemaining);

    // Cap at $744 unless elderly/disabled member in household
    shelterDeduction = hasElderlyOrDisabled
      ? excessShelter
      : Math.min(excessShelter, gaConfig.shelterDeductionCap);

    if (shelterDeduction > 0) {
      deductions.push({
        type: "SHELTER_EXCESS",
        amount: Math.round(shelterDeduction * 100) / 100,
        notes: `Shelter: $${totalShelterCost.toFixed(2)} - 50% of remaining ($${halfRemaining.toFixed(2)}) = $${excessShelter.toFixed(2)}${!hasElderlyOrDisabled && excessShelter > gaConfig.shelterDeductionCap ? ` (capped at $${gaConfig.shelterDeductionCap})` : " (uncapped — elderly/disabled)"}`,
      });
    }
  }

  // Step 8: Net income
  const totalDeductions = preDeductions + shelterDeduction;
  const netIncome = Math.max(0, grossIncome - totalDeductions);

  return {
    grossIncome: Math.round(grossIncome * 100) / 100,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    netIncome: Math.round(netIncome * 100) / 100,
    remainingIncomeBeforeShelter: Math.round(remainingIncome * 100) / 100,
    deductions,
    householdSize,
    hasElderlyOrDisabled,
  };
}

/**
 * Check gross income test: gross income must be at or below the limit for household size.
 * Elderly/disabled-only households skip this test.
 */
async function checkGrossIncomeTest(grossIncome, householdSize, stateCode, hasElderlyOrDisabled, fiscalYear = 2026) {
  if (hasElderlyOrDisabled) {
    return { passes: true, skipped: true, reason: "Elderly/disabled household — gross income test skipped" };
  }

  const limits = await getSnapLimits(fiscalYear, householdSize);
  const stateConfig = await getStateSnapConfig(stateCode);

  const limit = limits.grossIncomeLimit;
  const passes = grossIncome <= limit;

  return {
    passes,
    skipped: false,
    grossIncome: Math.round(grossIncome * 100) / 100,
    limit,
    bbcePercent: stateConfig.grossIncomePercent,
    reason: passes
      ? `Gross income $${grossIncome.toFixed(2)} ≤ $${limit} (${stateConfig.grossIncomePercent}% FPL for HH${householdSize})`
      : `Gross income $${grossIncome.toFixed(2)} > $${limit} (${stateConfig.grossIncomePercent}% FPL for HH${householdSize}) — DOES NOT PASS`,
  };
}

/**
 * Check net income test: net income must be at or below the limit.
 */
async function checkNetIncomeTest(netIncome, householdSize, fiscalYear = 2026) {
  const limits = await getSnapLimits(fiscalYear, householdSize);
  const limit = limits.netIncomeLimit;
  const passes = netIncome <= limit;

  return {
    passes,
    netIncome: Math.round(netIncome * 100) / 100,
    limit,
    reason: passes
      ? `Net income $${netIncome.toFixed(2)} ≤ $${limit} (100% FPL for HH${householdSize})`
      : `Net income $${netIncome.toFixed(2)} > $${limit} (100% FPL for HH${householdSize}) — DOES NOT PASS`,
  };
}

/**
 * Calculate the estimated monthly SNAP benefit.
 * benefit = maxAllotment - ceil(netIncome × 0.30)
 * Minimum benefit of $24 for 1-2 person households.
 */
async function calculateBenefitEstimate(netIncome, householdSize, fiscalYear = 2026) {
  const limits = await getSnapLimits(fiscalYear, householdSize);
  const expectedContribution = Math.ceil(netIncome * 0.30);
  let benefit = limits.maxAllotment - expectedContribution;

  // Minimum benefit for 1-2 person households
  if (householdSize <= gaConfig.minimumBenefitMaxHouseholdSize && benefit > 0 && benefit < gaConfig.minimumBenefit) {
    benefit = gaConfig.minimumBenefit;
  }

  benefit = Math.max(0, benefit);

  return {
    maxAllotment: limits.maxAllotment,
    expectedContribution,
    estimatedBenefit: benefit,
    householdSize,
  };
}

/**
 * Check if the case qualifies for 7-day expedited processing.
 */
function checkExpeditedEligibility(grossMonthlyIncome, liquidResources, monthlyRent, monthlyUtilities) {
  const reasons = [];

  // Condition 1: gross < $150 AND liquid resources < $100
  if (grossMonthlyIncome < 150 && liquidResources < 100) {
    reasons.push("Gross monthly income < $150 and liquid resources < $100");
  }

  // Condition 2: combined income + resources < rent + utilities
  const combined = grossMonthlyIncome + liquidResources;
  const shelter = monthlyRent + monthlyUtilities;
  if (combined < shelter) {
    reasons.push(`Combined income + resources ($${combined.toFixed(2)}) < monthly shelter costs ($${shelter.toFixed(2)})`);
  }

  return {
    eligible: reasons.length > 0,
    reasons,
  };
}

/**
 * Get the standard utility allowance for Georgia based on utility type.
 */
function getStandardUtilityAllowance(utilityType) {
  return gaConfig.standardUtilityAllowances[utilityType] || 0;
}

/**
 * Run the full SNAP eligibility calculation for an intake.
 */
async function calculateFullEligibility(intake, stateCode = "GA", fiscalYear = 2026) {
  const deductionResult = await calculateDeductions(intake, fiscalYear);

  const grossTest = await checkGrossIncomeTest(
    deductionResult.grossIncome,
    deductionResult.householdSize,
    stateCode,
    deductionResult.hasElderlyOrDisabled,
    fiscalYear
  );

  const netTest = await checkNetIncomeTest(
    deductionResult.netIncome,
    deductionResult.householdSize,
    fiscalYear
  );

  const benefitEstimate = await calculateBenefitEstimate(
    deductionResult.netIncome,
    deductionResult.householdSize,
    fiscalYear
  );

  const shelter = intake.shelterExpense || {};
  const expedited = checkExpeditedEligibility(
    deductionResult.grossIncome,
    intake.liquidResources || 0,
    shelter.rentOrMortgage || 0,
    shelter.standardUtilityAllowance || 0
  );

  const eligible = grossTest.passes && netTest.passes;

  return {
    eligible,
    grossIncomeTest: grossTest,
    netIncomeTest: netTest,
    deductions: deductionResult,
    benefitEstimate,
    expedited,
  };
}

module.exports = {
  calculateMonthlyIncome,
  calculateHouseholdGrossIncome,
  calculateDeductions,
  checkGrossIncomeTest,
  checkNetIncomeTest,
  calculateBenefitEstimate,
  checkExpeditedEligibility,
  getStandardUtilityAllowance,
  calculateFullEligibility,
  getSnapLimits,
  getStateSnapConfig,
  FREQUENCY_MULTIPLIERS,
};
