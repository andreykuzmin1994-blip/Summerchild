const prisma = require("../lib/prisma");
const gaConfig = require("../config/ga-snap-deductions-fy2026.json");

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
    explanation: `Every SNAP household receives a standard deduction based on household size. For a household of ${householdSize}, this is $${standardDeduction} per month [7 CFR § 273.9(d)(2)].`,
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
      explanation: `20% of all earned income (wages, salary, self-employment) is deducted to account for work-related costs. Total earned income is $${totalEarned.toFixed(2)}, so the deduction is $${earnedIncomeDeduction.toFixed(2)} [7 CFR § 273.9(d)(1)].`,
    });
  }

  // Step 3: Dependent care deduction
  const dependentCare = intake.dependentCareExpense || 0;
  if (dependentCare > 0) {
    deductions.push({
      type: "DEPENDENT_CARE",
      amount: dependentCare,
      notes: `Dependent care expense: $${dependentCare}`,
      explanation: `Dependent care costs that allow a household member to work or attend training are deductible. The reported dependent care expense of $${dependentCare} per month is deducted in full [7 CFR § 273.9(d)(3)].`,
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
    const medicalMethod = medicalDeduction === gaConfig.standardMedicalDeduction
      ? `the standard medical deduction of $${gaConfig.standardMedicalDeduction}`
      : `the actual excess above $${gaConfig.medicalDeductionThreshold} ($${medicalExpenses} − $${gaConfig.medicalDeductionThreshold} = $${medicalExpenses - gaConfig.medicalDeductionThreshold})`;
    deductions.push({
      type: "MEDICAL",
      amount: medicalDeduction,
      notes: `Medical deduction for elderly/disabled (expenses: $${medicalExpenses}): $${medicalDeduction}`,
      explanation: `Because the household includes an elderly or disabled member with medical expenses over $${gaConfig.medicalDeductionThreshold}/month, ${medicalMethod} is applied — whichever is greater. The medical deduction is $${medicalDeduction} [7 CFR § 273.9(d)(6)].`,
    });
  }

  // Step 5: Child support paid
  const childSupportPaid = intake.childSupportPaid || 0;
  if (childSupportPaid > 0) {
    deductions.push({
      type: "CHILD_SUPPORT_PAID",
      amount: childSupportPaid,
      notes: `Child support paid: $${childSupportPaid}`,
      explanation: `Legally owed child support payments made by a household member are deductible. The reported child support payment of $${childSupportPaid} per month is deducted in full [7 CFR § 273.9(d)(4)].`,
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
      const capNote = hasElderlyOrDisabled
        ? "Because the household includes an elderly or disabled member, this deduction is not capped."
        : excessShelter > gaConfig.shelterDeductionCap
          ? `This is capped at $${gaConfig.shelterDeductionCap} because no elderly or disabled member is in the household.`
          : `This is below the $${gaConfig.shelterDeductionCap} cap.`;
      deductions.push({
        type: "SHELTER_EXCESS",
        amount: Math.round(shelterDeduction * 100) / 100,
        notes: `Shelter: $${totalShelterCost.toFixed(2)} - 50% of remaining ($${halfRemaining.toFixed(2)}) = $${excessShelter.toFixed(2)}${!hasElderlyOrDisabled && excessShelter > gaConfig.shelterDeductionCap ? ` (capped at $${gaConfig.shelterDeductionCap})` : " (uncapped — elderly/disabled)"}`,
        explanation: `Shelter excess deduction: total shelter costs ($${totalShelterCost.toFixed(2)}) minus 50% of income after other deductions ($${halfRemaining.toFixed(2)}) = $${excessShelter.toFixed(2)}. ${capNote} Final shelter deduction: $${(Math.round(shelterDeduction * 100) / 100).toFixed(2)} [7 CFR § 273.9(d)(5)].`,
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
    return {
      passes: true,
      skipped: true,
      reason: "Elderly/disabled household — gross income test skipped",
      explanation: "Households with an elderly (60+) or disabled member are exempt from the gross income test [7 CFR § 273.9(a)].",
    };
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
    explanation: passes
      ? `The household's gross monthly income of $${grossIncome.toFixed(2)} is at or below the limit of $${limit} (${stateConfig.grossIncomePercent}% of the Federal Poverty Level for a household of ${householdSize}). The gross income test is passed [7 CFR § 273.9(a)].`
      : `The household's gross monthly income of $${grossIncome.toFixed(2)} exceeds the limit of $${limit} (${stateConfig.grossIncomePercent}% of the Federal Poverty Level for a household of ${householdSize}). The gross income test is not passed [7 CFR § 273.9(a)].`,
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
    explanation: passes
      ? `After all deductions, the household's net monthly income is $${netIncome.toFixed(2)}, which is at or below the limit of $${limit} (100% of the Federal Poverty Level for a household of ${householdSize}). The net income test is passed [7 CFR § 273.9(a)].`
      : `After all deductions, the household's net monthly income is $${netIncome.toFixed(2)}, which exceeds the limit of $${limit} (100% of the Federal Poverty Level for a household of ${householdSize}). The net income test is not passed [7 CFR § 273.9(a)].`,
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

  const minBenefitApplied = householdSize <= gaConfig.minimumBenefitMaxHouseholdSize
    && benefit === gaConfig.minimumBenefit
    && limits.maxAllotment - expectedContribution < gaConfig.minimumBenefit
    && limits.maxAllotment - expectedContribution > 0;

  return {
    maxAllotment: limits.maxAllotment,
    expectedContribution,
    estimatedBenefit: benefit,
    householdSize,
    explanation: benefit === 0
      ? `The household's expected contribution (30% of net income = $${expectedContribution}) equals or exceeds the maximum allotment of $${limits.maxAllotment} for a household of ${householdSize}. The estimated benefit is $0 [7 CFR § 273.10(e)].`
      : minBenefitApplied
        ? `The maximum allotment for a household of ${householdSize} is $${limits.maxAllotment}. After subtracting the expected contribution of $${expectedContribution} (30% of net income), the calculated benefit would be $${limits.maxAllotment - expectedContribution}. Because households of 1–2 members receive at least $${gaConfig.minimumBenefit}, the estimated monthly benefit is $${benefit} [7 CFR § 273.10(e)].`
        : `The maximum allotment for a household of ${householdSize} is $${limits.maxAllotment}. After subtracting the expected contribution of $${expectedContribution} (30% of net income), the estimated monthly benefit is $${benefit} [7 CFR § 273.10(e)].`,
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

  const explanationParts = [];
  if (grossMonthlyIncome < 150 && liquidResources < 100) {
    explanationParts.push(`Gross monthly income ($${grossMonthlyIncome.toFixed(2)}) is under $150 and liquid resources ($${liquidResources.toFixed(2)}) are under $100.`);
  }
  if (combined < shelter) {
    explanationParts.push(`Combined income and resources ($${combined.toFixed(2)}) are less than monthly shelter costs ($${shelter.toFixed(2)}).`);
  }

  return {
    eligible: reasons.length > 0,
    reasons,
    explanation: reasons.length > 0
      ? `This household qualifies for expedited (7-day) processing. ${explanationParts.join(" ")} [7 CFR § 273.2(i)(1)].`
      : `This household does not meet expedited processing criteria. Gross income is $${grossMonthlyIncome.toFixed(2)}, liquid resources are $${liquidResources.toFixed(2)}, and combined ($${combined.toFixed(2)}) is not less than shelter costs ($${shelter.toFixed(2)}) [7 CFR § 273.2(i)(1)].`,
  };
}

/**
 * Get the standard utility allowance for Georgia based on utility type.
 */
function getStandardUtilityAllowance(utilityType) {
  return gaConfig.standardUtilityAllowances[utilityType] || 0;
}

/**
 * Generate a complete plain-language explanation of a SNAP eligibility calculation.
 * Designed for caseworker review — every step cites the applicable CFR section.
 */
function generateCalculationExplanation(result) {
  const lines = [];
  const { deductions, grossIncomeTest, netIncomeTest, benefitEstimate, expedited } = result;

  lines.push(`SNAP ELIGIBILITY CALCULATION SUMMARY`);
  lines.push(`Household size: ${deductions.householdSize}${deductions.hasElderlyOrDisabled ? " (includes elderly/disabled member)" : ""}`);
  lines.push(`Gross monthly income: $${deductions.grossIncome.toFixed(2)}`);
  lines.push(``);

  // Deductions narrative
  lines.push(`DEDUCTIONS APPLIED:`);
  for (const d of deductions.deductions) {
    lines.push(`  ${d.type}: $${d.amount.toFixed(2)} — ${d.explanation}`);
  }
  lines.push(`Total deductions: $${deductions.totalDeductions.toFixed(2)}`);
  lines.push(`Net monthly income: $${deductions.netIncome.toFixed(2)}`);
  lines.push(``);

  // Income tests
  lines.push(`INCOME TESTS:`);
  lines.push(`  Gross income test: ${grossIncomeTest.explanation}`);
  lines.push(`  Net income test: ${netIncomeTest.explanation}`);
  lines.push(``);

  // Benefit estimate
  lines.push(`BENEFIT ESTIMATE:`);
  lines.push(`  ${benefitEstimate.explanation}`);
  lines.push(``);

  // Expedited
  lines.push(`EXPEDITED PROCESSING:`);
  lines.push(`  ${expedited.explanation}`);

  return lines.join("\n");
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

  const fullResult = {
    eligible,
    grossIncomeTest: grossTest,
    netIncomeTest: netTest,
    deductions: deductionResult,
    benefitEstimate,
    expedited,
  };

  fullResult.explanation = generateCalculationExplanation(fullResult);

  return fullResult;
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
  generateCalculationExplanation,
  getSnapLimits,
  getStateSnapConfig,
  FREQUENCY_MULTIPLIERS,
};
