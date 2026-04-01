const { getSnapLimits } = require("./snapCalculator");

/**
 * Run all consistency checks on a completed intake.
 * Returns risk score, flags array, and expedited eligibility.
 */
async function runConsistencyChecks(intake, calculations, fiscalYear = 2026) {
  const flags = [];

  flags.push(...checkIncomeVsExpenses(intake, calculations));
  flags.push(...checkHouseholdIncomeGaps(intake));
  flags.push(...checkDeductionEligibility(intake));
  flags.push(...(await checkThresholdProximity(intake, calculations, fiscalYear)));
  flags.push(...checkShelterConsistency(intake));
  flags.push(...checkExpeditedCriteria(calculations));

  const riskScore = deriveRiskScore(flags);

  return {
    riskScore,
    flags,
    expedited: calculations.expedited,
    calculations: {
      grossMonthlyIncome: calculations.deductions.grossIncome,
      netMonthlyIncome: calculations.deductions.netIncome,
      estimatedBenefit: calculations.benefitEstimate.estimatedBenefit,
      deductionsApplied: calculations.deductions.deductions,
    },
  };
}

/**
 * Flag if total shelter + utilities > 80% of reported gross income.
 */
function checkIncomeVsExpenses(intake, calculations) {
  const flags = [];
  const grossIncome = calculations.deductions.grossIncome;
  const shelter = intake.shelterExpense;

  if (shelter && grossIncome > 0) {
    const totalShelter = shelter.totalShelterCost || 0;
    if (totalShelter > grossIncome * 0.8) {
      flags.push({
        type: "INCOME_EXPENSE_MISMATCH",
        severity: "HIGH",
        field: "income",
        message: `Reported expenses ($${totalShelter.toFixed(2)}) significantly exceed 80% of reported gross income ($${grossIncome.toFixed(2)}) — verify income sources`,
        suggestedAction: "Verify all income sources and shelter expense amounts",
      });
    }
  }

  return flags;
}

/**
 * For each adult (18+) in household, check if at least one income source exists.
 */
function checkHouseholdIncomeGaps(intake) {
  const flags = [];
  const members = intake.householdMembers || [];

  for (const member of members) {
    if (!member.inSnapHousehold) continue;

    const age = member.dob ? getAge(member.dob) : null;
    if (age !== null && age < 18) continue;

    if (!member.hasEarnedIncome && !member.hasUnearnedIncome) {
      const incomeSources = (intake.incomeSources || []).filter(
        (s) => s.householdMemberId === member.id
      );
      if (incomeSources.length === 0) {
        flags.push({
          type: "HOUSEHOLD_MEMBER_NO_INCOME",
          severity: "MEDIUM",
          field: "household",
          member: `${member.firstName} ${member.lastName}`,
          message: `${member.firstName} ${member.lastName} has no reported income — verify employment/benefits status`,
          suggestedAction: "Ask about SSI/SSDI/employment status",
        });
      }
    }
  }

  return flags;
}

/**
 * Verify deduction eligibility requirements:
 * - Dependent care requires earned income or training
 * - Medical expenses require elderly/disabled member
 */
function checkDeductionEligibility(intake) {
  const flags = [];
  const members = intake.householdMembers || [];
  const incomeSources = intake.incomeSources || [];

  const hasElderlyOrDisabled = members.some((m) => m.isElderly || m.isDisabled);
  const hasEarnedIncome = incomeSources.some(
    (s) => s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT"
  );

  // Dependent care claimed but no earned income
  if ((intake.dependentCareExpense || 0) > 0 && !hasEarnedIncome) {
    flags.push({
      type: "DEDUCTION_ELIGIBILITY",
      severity: "HIGH",
      field: "deductions",
      message: "Dependent care deduction requires work or training activity — no earned income reported",
      suggestedAction: "Verify employment or training enrollment",
    });
  }

  // Medical expenses claimed but no elderly/disabled member
  if ((intake.medicalExpenses || 0) > 0 && !hasElderlyOrDisabled) {
    flags.push({
      type: "DEDUCTION_ELIGIBILITY",
      severity: "HIGH",
      field: "deductions",
      message: "Medical expense deduction requires elderly (60+) or disabled household member — none reported",
      suggestedAction: "Verify household member ages and disability status",
    });
  }

  return flags;
}

/**
 * Flag cases where income is within 5% of eligibility thresholds.
 */
async function checkThresholdProximity(intake, calculations, fiscalYear) {
  const flags = [];
  const { grossIncome, netIncome, householdSize } = calculations.deductions;
  const limits = await getSnapLimits(fiscalYear, householdSize);

  // Gross income within 5% of limit
  const grossThreshold = limits.grossIncomeLimit * 0.05;
  if (Math.abs(grossIncome - limits.grossIncomeLimit) <= grossThreshold) {
    flags.push({
      type: "THRESHOLD_PROXIMITY",
      severity: "MEDIUM",
      field: "income",
      message: `Gross income ($${grossIncome.toFixed(2)}) is within 5% of the $${limits.grossIncomeLimit} limit — verify all income sources carefully`,
      suggestedAction: "Double-check all income amounts and pay frequencies",
    });
  }

  // Net income within 5% of limit
  const netThreshold = limits.netIncomeLimit * 0.05;
  if (Math.abs(netIncome - limits.netIncomeLimit) <= netThreshold) {
    flags.push({
      type: "THRESHOLD_PROXIMITY",
      severity: "MEDIUM",
      field: "income",
      message: `Net income ($${netIncome.toFixed(2)}) is within 5% of the $${limits.netIncomeLimit} limit — verify all deductions and income figures`,
      suggestedAction: "Verify deduction eligibility and all income amounts",
    });
  }

  return flags;
}

/**
 * Check if shelter costs may include utilities when a heating/cooling SUA is also claimed.
 */
function checkShelterConsistency(intake) {
  const flags = [];
  const shelter = intake.shelterExpense;

  if (!shelter) return flags;

  // If heating/cooling SUA claimed and rent is suspiciously high, flag potential double-counting
  if (
    shelter.utilityType === "HEATING_COOLING" &&
    shelter.rentOrMortgage > 0 &&
    intake.shelterIncludesUtilities
  ) {
    flags.push({
      type: "SHELTER_UTILITY_OVERLAP",
      severity: "MEDIUM",
      field: "shelter",
      message: "Verify whether reported rent includes utilities to avoid double-counting with SUA",
      suggestedAction: "Ask applicant if rent amount includes utility payments",
    });
  }

  return flags;
}

/**
 * Flag cases that qualify for 7-day expedited processing.
 */
function checkExpeditedCriteria(calculations) {
  const flags = [];

  if (calculations.expedited && calculations.expedited.eligible) {
    flags.push({
      type: "EXPEDITED_ELIGIBLE",
      severity: "INFO",
      field: "expedited",
      message: `Case qualifies for 7-day expedited processing: ${calculations.expedited.reasons.join("; ")}`,
      suggestedAction: "Prioritize this case for expedited processing",
    });
  }

  return flags;
}

function deriveRiskScore(flags) {
  const hasHigh = flags.some((f) => f.severity === "HIGH");
  const hasMedium = flags.some((f) => f.severity === "MEDIUM");

  if (hasHigh) return "HIGH";
  if (hasMedium) return "MEDIUM";
  return "LOW";
}

function getAge(dob) {
  const today = new Date();
  const birthDate = new Date(dob);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

module.exports = {
  runConsistencyChecks,
  checkIncomeVsExpenses,
  checkHouseholdIncomeGaps,
  checkDeductionEligibility,
  checkThresholdProximity,
  checkShelterConsistency,
  checkExpeditedCriteria,
};
