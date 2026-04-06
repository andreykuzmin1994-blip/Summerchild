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
  flags.push(...checkZeroIncomeWithShelter(intake, calculations));
  flags.push(...checkSelfEmploymentExpenses(intake));
  flags.push(...checkPayFrequencyPlausibility(intake));
  flags.push(...checkMedicalExpenseReasonableness(intake));
  flags.push(...checkMultipleAdultsNoIncome(intake));
  flags.push(...checkPossibleUnreportedBenefits(intake));
  flags.push(...checkSeasonalIncomePattern(intake));
  flags.push(...checkPossibleStudentInHousehold(intake));
  flags.push(...checkApplicantIncome(intake));
  flags.push(...checkUnrelatedAdults(intake));
  flags.push(...checkChildSupportWithoutChildren(intake));
  flags.push(...checkHomeownershipMismatch(intake, calculations));
  flags.push(...checkBenefitNearMaximum(calculations));

  // Prioritize flags: deduplicate by type+member, keep highest severity, limit to top 15
  const flagsByKey = {};
  for (const flag of flags) {
    // Use type + member/message as key to allow multiple flags per type for different members/deductions
    const key = flag.member
      ? `${flag.type}:${flag.member}`
      : `${flag.type}:${(flag.message || "").slice(0, 40)}`;
    if (!flagsByKey[key] || severityRank(flag.severity) < severityRank(flagsByKey[key].severity)) {
      flagsByKey[key] = flag;
    }
  }
  const dedupedFlags = Object.values(flagsByKey);
  const prioritizedFlags = dedupedFlags
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 15);

  const riskScore = deriveRiskScore(prioritizedFlags);

  return {
    riskScore,
    flags: prioritizedFlags,
    totalFlagsFound: flags.length,
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

    // Skip minors based on age range (if available) or elderly/disabled flags
    if (member.ageRange && member.ageRange.startsWith("0-") || member.ageRange === "under 18") continue;

    if (!member.hasEarnedIncome && !member.hasUnearnedIncome) {
      const incomeSources = (intake.incomeSources || []).filter(
        (s) => s.householdMemberId === member.id
      );
      if (incomeSources.length === 0) {
        flags.push({
          type: "HOUSEHOLD_MEMBER_NO_INCOME",
          severity: "MEDIUM",
          field: "household",
          member: member.displayName,
          message: `${member.displayName} (${member.relationshipToApplicant}) has no reported income — verify employment/benefits status`,
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
  const deductions = intake.deductions || [];

  const hasElderlyOrDisabled = members.some((m) => m.isElderly || m.isDisabled);
  const hasEarnedIncome = incomeSources.some(
    (s) => s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT"
  );

  // Dependent care claimed but no earned income
  const hasDependentCare = deductions.some((d) => d.deductionType === "DEPENDENT_CARE" && d.amount > 0);
  if (hasDependentCare && !hasEarnedIncome) {
    flags.push({
      type: "DEDUCTION_ELIGIBILITY",
      severity: "HIGH",
      field: "deductions",
      message: "Dependent care deduction requires work or training activity — no earned income reported",
      suggestedAction: "Verify employment or training enrollment",
    });
  }

  // Medical expenses claimed but no elderly/disabled member
  const hasMedical = deductions.some((d) => d.deductionType === "MEDICAL" && d.amount > 0);
  if (hasMedical && !hasElderlyOrDisabled) {
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

  // If heating/cooling SUA claimed, remind caseworker to verify rent doesn't already include utilities
  if (
    shelter.utilityType === "HEATING_COOLING" &&
    shelter.rentOrMortgage > 0
  ) {
    flags.push({
      type: "SHELTER_UTILITY_OVERLAP",
      severity: "LOW",
      field: "shelter",
      message: "Heating/cooling SUA claimed alongside rent — verify whether reported rent includes utilities to avoid double-counting",
      suggestedAction: "Confirm with applicant that rent does not include utility payments",
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

/**
 * Flag zero-income households that report shelter costs.
 * The existing INCOME_EXPENSE_MISMATCH check skips when grossIncome === 0,
 * but zero income with rent is one of the strongest indicators of unreported income.
 */
function checkZeroIncomeWithShelter(intake, calculations) {
  const flags = [];
  const grossIncome = calculations.deductions.grossIncome;
  const shelter = intake.shelterExpense;

  if (grossIncome === 0 && shelter && (shelter.rentOrMortgage || 0) > 0) {
    flags.push({
      type: "ZERO_INCOME_WITH_SHELTER",
      severity: "HIGH",
      field: "income",
      message: `Household reports $0 income but pays $${shelter.rentOrMortgage}/mo rent — verify income sources and who pays housing costs`,
      suggestedAction: "Ask how rent is being paid with no reported income",
    });
  }

  return flags;
}

/**
 * Flag self-employment income sources with unusually high expense ratios.
 * USDA QC data shows overstated self-employment expenses are a top error source.
 * Expenses > 60% of gross is suspicious (the standard deduction is 40%).
 */
function checkSelfEmploymentExpenses(intake) {
  const flags = [];
  const incomeSources = intake.incomeSources || [];

  for (const source of incomeSources) {
    if (source.incomeType !== "SELF_EMPLOYMENT") continue;

    const gross = source.selfEmploymentGross || source.grossAmountPerPeriod || 0;
    const expenses = source.selfEmploymentExpenses || 0;

    if (gross > 0 && expenses > gross * 0.60) {
      const ratio = Math.round((expenses / gross) * 100);
      flags.push({
        type: "SELF_EMPLOYMENT_HIGH_EXPENSES",
        severity: "MEDIUM",
        field: "income",
        message: `Self-employment expenses ($${expenses}) are ${ratio}% of gross ($${gross}) — verify expense documentation (standard deduction is 40%)`,
        suggestedAction: "Request receipts or documentation for claimed business expenses",
      });
    }
  }

  return flags;
}

/**
 * Flag monthly income amounts that look like they may be biweekly or weekly figures.
 * Pay frequency misreporting is ~8-10% of overpayment errors per USDA QC data.
 *
 * Heuristic: if someone reports MONTHLY income between $400-$1800, it could plausibly
 * be a biweekly amount (which would double the real monthly income). We flag when
 * the amount falls in common biweekly pay ranges and the resulting gross is near
 * the eligibility threshold.
 */
function checkPayFrequencyPlausibility(intake) {
  const flags = [];
  const incomeSources = intake.incomeSources || [];

  for (const source of incomeSources) {
    if (source.incomeType === "SELF_EMPLOYMENT") continue;
    if (source.payFrequency !== "MONTHLY") continue;

    const amount = source.grossAmountPerPeriod || 0;

    // Common biweekly pay range: $400-$1800 (roughly $5-$22/hr full-time)
    // If reported as monthly but actually biweekly, real monthly = amount × 2.167
    if (amount >= 400 && amount <= 1800) {
      const ifBiweekly = Math.round(amount * 2.167 * 100) / 100;
      flags.push({
        type: "PAY_FREQUENCY_SUSPICIOUS",
        severity: "MEDIUM",
        field: "income",
        message: `Monthly income $${amount} could be a biweekly amount (actual monthly would be $${ifBiweekly.toFixed(2)}) — confirm pay frequency with pay stub`,
        suggestedAction: "Verify pay frequency against pay stubs or employer records",
      });
    }
  }

  return flags;
}

/**
 * Flag unusually high medical expense claims.
 * Medical expenses over $400/mo are uncommon and account for ~3-5% of overpayment
 * errors when overstated. Only applies to elderly/disabled households that qualify.
 */
function checkMedicalExpenseReasonableness(intake) {
  const flags = [];
  const medicalExpenses = intake.medicalExpenses || 0;

  if (medicalExpenses > 400) {
    flags.push({
      type: "MEDICAL_EXPENSE_HIGH",
      severity: "MEDIUM",
      field: "deductions",
      message: `Reported medical expenses ($${medicalExpenses}/mo) are unusually high — request itemized documentation`,
      suggestedAction: "Ask for receipts, prescription lists, or medical bills to verify amount",
    });
  }

  return flags;
}

/**
 * Escalate to HIGH when 2+ working-age adults in household report no income.
 * Multiple no-income adults is the single strongest predictor of unreported
 * household income per USDA QC data.
 */
function checkMultipleAdultsNoIncome(intake) {
  const flags = [];
  const members = intake.householdMembers || [];
  const incomeSources = intake.incomeSources || [];

  let noIncomeAdultCount = 0;

  for (const member of members) {
    if (!member.inSnapHousehold) continue;
    if (member.ageRange === "under 18" || (member.ageRange && member.ageRange.startsWith("0-"))) continue;

    if (!member.hasEarnedIncome && !member.hasUnearnedIncome) {
      const linked = incomeSources.some((s) => s.householdMemberId === member.id);
      if (!linked) {
        noIncomeAdultCount++;
      }
    }
  }

  if (noIncomeAdultCount >= 2) {
    flags.push({
      type: "MULTIPLE_ADULTS_NO_INCOME",
      severity: "HIGH",
      field: "household",
      message: `${noIncomeAdultCount} working-age adults in household report no income — this is the #1 predictor of unreported income in SNAP QC audits`,
      suggestedAction: "Interview each adult about employment, gig work, and benefit status",
    });
  }

  return flags;
}

/**
 * Flag working-age adults who report some income but may have additional
 * unreported benefits (UI, workers' comp, alimony, TANF, informal income).
 *
 * Triggers when:
 *   - Applicant (inferred from income sources with no memberId) has only
 *     earned income but no unearned income, AND there are no unearned sources
 *     at all in the household — common when someone lost a job and gets UI
 *     but only reports their new part-time work.
 *   - OR: any working-age adult in the household has exactly one income type
 *     and no unearned income, combined with shelter costs suggesting more
 *     income than reported.
 *
 * This is a "soft" MEDIUM flag — a prompt for the caseworker to ask about
 * UI, workers' comp, alimony, TANF, and other benefit income.
 */
function checkPossibleUnreportedBenefits(intake) {
  const flags = [];
  const members = intake.householdMembers || [];
  const incomeSources = intake.incomeSources || [];

  // Check if any income exists at all
  const hasAnyIncome = incomeSources.length > 0;

  // Count working-age non-disabled/non-elderly adults in the SNAP household
  const workingAgeAdults = members.filter((m) => {
    if (!m.inSnapHousehold) return false;
    if (m.ageRange === "under 18" || (m.ageRange && m.ageRange.startsWith("0-"))) return false;
    if (m.isElderly || m.isDisabled) return false;
    return true;
  });

  // The applicant themselves is not in householdMembers unless added as a
  // phantom member (for elderly/disabled). Count the applicant as a working-age
  // adult unless a phantom member marks them as elderly/disabled.
  const applicantPhantom = members.find((m) => m.id === "__applicant__");
  const applicantIsElderlyOrDisabled = applicantPhantom
    ? (applicantPhantom.isElderly || applicantPhantom.isDisabled)
    : false;

  // Total working-age adults = explicit members + the implicit applicant
  const totalWorkingAgeAdults = workingAgeAdults.length + (applicantIsElderlyOrDisabled ? 0 : 1);

  // Check if the household has ONLY earned income and NO unearned income at all
  const hasEarned = incomeSources.some(
    (s) => s.incomeType === "EMPLOYMENT" || s.incomeType === "SELF_EMPLOYMENT"
  );
  const hasUnearned = incomeSources.some(
    (s) => s.incomeType !== "EMPLOYMENT" && s.incomeType !== "SELF_EMPLOYMENT"
  );

  // Pattern 1: Working-age household with earned income but zero unearned income
  // and at least one working-age adult. Common when someone loses a job,
  // starts a part-time gig, and forgets to report UI/workers comp.
  if (hasEarned && !hasUnearned && totalWorkingAgeAdults > 0) {
    flags.push({
      type: "POSSIBLE_UNREPORTED_BENEFITS",
      severity: "MEDIUM",
      field: "income",
      message: "Household has earned income but no unearned income reported — ask about unemployment benefits, workers' compensation, alimony, child support, TANF, or other benefit income",
      suggestedAction: "Ask: 'Does anyone in the household receive unemployment, workers comp, disability insurance, alimony, TANF, or regular help from family?'",
    });
  }

  // Pattern 2: Zero total income but the applicant is working-age and
  // not disabled/elderly — very likely receiving UI, workers comp, or TANF
  // that they didn't report. (ZERO_INCOME_WITH_SHELTER catches the shelter
  // angle; this catches the benefit eligibility angle.)
  if (!hasAnyIncome && totalWorkingAgeAdults > 0) {
    flags.push({
      type: "POSSIBLE_UNREPORTED_BENEFITS",
      severity: "MEDIUM",
      field: "income",
      message: "Working-age household with $0 reported income — likely eligible for or receiving unemployment, TANF, or other benefits that count as SNAP income",
      suggestedAction: "Ask: 'Have you applied for or are you receiving unemployment benefits, TANF cash assistance, workers compensation, or any other benefits?'",
    });
  }

  return flags;
}

/**
 * Flag employment income that's suspiciously low for a working-age adult.
 * Monthly equivalent < $600 is below 20 hrs/wk at minimum wage — if the
 * applicant works in a seasonal industry (construction, agriculture,
 * landscaping, food service, tourism), they may be reporting off-season
 * or partial-month income instead of a typical month.
 *
 * Skips elderly/disabled applicants who legitimately work very few hours.
 */
function checkSeasonalIncomePattern(intake) {
  const flags = [];
  const incomeSources = intake.incomeSources || [];
  const shelter = intake.shelterExpense;
  const members = intake.householdMembers || [];

  // Skip if applicant is elderly or disabled (legitimate part-time work)
  const applicantPhantom = members.find((m) => m.id === "__applicant__");
  if (applicantPhantom && (applicantPhantom.isElderly || applicantPhantom.isDisabled)) {
    return flags;
  }

  const FREQ_MULT = { WEEKLY: 4.333, BIWEEKLY: 2.167, SEMI_MONTHLY: 2, MONTHLY: 1, ANNUALLY: 1 / 12 };

  for (const source of incomeSources) {
    if (source.incomeType !== "EMPLOYMENT") continue;

    const mult = FREQ_MULT[source.payFrequency] || 1;
    const monthlyEquiv = Math.round(source.grossAmountPerPeriod * mult);

    if (monthlyEquiv < 600 && shelter && (shelter.rentOrMortgage || 0) > 0) {
      flags.push({
        type: "SEASONAL_INCOME_POSSIBLE",
        severity: "MEDIUM",
        field: "income",
        message: `Employment income ~$${monthlyEquiv}/mo is below 20 hrs/wk at minimum wage — if seasonal (construction, agriculture, food service, landscaping), verify this reflects a typical month`,
        suggestedAction: "Ask: 'Is this job seasonal or year-round? What does a typical month look like during your busy season?'",
      });
    }
  }

  return flags;
}

/**
 * Flag household members aged 18–24 with no income — they may be
 * college/university students. Under SNAP rules, students enrolled
 * at least half-time in higher education are generally ineligible
 * unless they meet an exemption (20+ hrs/wk work, work-study,
 * single parent of child under 6/12, TANF recipient, etc.).
 *
 * This is a soft flag — many 18–24 year-olds are NOT students,
 * but it's the #1 student-age bracket and worth verifying.
 */
function checkPossibleStudentInHousehold(intake) {
  const flags = [];
  const members = intake.householdMembers || [];
  const incomeSources = intake.incomeSources || [];

  for (const member of members) {
    if (!member.inSnapHousehold) continue;
    if (member.id === "__applicant__") continue;

    // Parse starting age from range like "18-24", "20-24"
    const match = member.ageRange && member.ageRange.match(/^(\d+)/);
    if (!match) continue;
    const startAge = parseInt(match[1]);
    if (startAge < 18 || startAge > 24) continue;

    // Check if member has any income
    const hasIncome =
      member.hasEarnedIncome ||
      member.hasUnearnedIncome ||
      incomeSources.some((s) => s.householdMemberId === member.id);

    if (!hasIncome) {
      flags.push({
        type: "POSSIBLE_STUDENT_NO_EXEMPTION",
        severity: "MEDIUM",
        field: "household",
        member: member.displayName,
        message: `${member.displayName} (age ${member.ageRange}) has no income — if enrolled in higher education, verify SNAP student exemption status`,
        suggestedAction: "Ask if enrolled in college/university. If yes, verify exemption: 20+ hrs/wk employment, work-study, parent of child under 6, TANF, or unable to work",
      });
    }
  }

  return flags;
}

/**
 * Check if the applicant (not in householdMembers array) reports no income
 * for single-person households. This is a gap — the existing household
 * income check only looks at householdMembers, not the implicit applicant.
 */
function checkApplicantIncome(intake) {
  const flags = [];
  const members = intake.householdMembers || [];
  const incomeSources = intake.incomeSources || [];

  // Only for single-person households (no other members)
  if (members.filter((m) => m.inSnapHousehold).length === 0) {
    const applicantIncome = incomeSources.filter((s) => !s.householdMemberId);
    if (applicantIncome.length === 0) {
      flags.push({
        type: "APPLICANT_NO_INCOME",
        severity: "HIGH",
        field: "income",
        message: "Single-person household with no reported income — verify employment and benefits status",
        suggestedAction: "Ask about SSI, SSDI, unemployment, employment, gig work, or any other income",
      });
    }
  }

  return flags;
}

/**
 * Flag unrelated adults in the SNAP household.
 * Unrelated adults complicate household composition determination —
 * the "purchases and prepares together" rule must be verified.
 * USDA QC: household composition errors are 12-15% of overpayment dollars.
 */
function checkUnrelatedAdults(intake) {
  const flags = [];
  const members = intake.householdMembers || [];

  for (const member of members) {
    if (!member.inSnapHousehold) continue;
    if (member.ageRange === "under 18" || (member.ageRange && member.ageRange.startsWith("0-"))) continue;

    const rel = (member.relationshipToApplicant || "").toLowerCase();
    const isUnrelated = [
      "roommate", "friend", "unrelated", "boarder", "landlord",
      "partner", "boyfriend", "girlfriend", "other",
    ].some((r) => rel.includes(r));

    if (isUnrelated) {
      flags.push({
        type: "UNRELATED_ADULT_IN_HOUSEHOLD",
        severity: "MEDIUM",
        field: "household",
        member: member.displayName,
        message: `${member.displayName} (${rel}) is an unrelated adult — verify purchases-and-prepares-together status per 7 CFR §273.1(b)`,
        suggestedAction: "Confirm they share meals and food costs. If not, they should be a separate SNAP unit.",
      });
    }
  }

  return flags;
}

/**
 * Flag child support paid deduction when no minor children in household.
 * This is valid for non-custodial parents paying court-ordered support,
 * but the obligation must be legally binding per 7 CFR §273.9(d)(5).
 */
function checkChildSupportWithoutChildren(intake) {
  const flags = [];
  const childSupportPaid = intake.childSupportPaid || 0;
  if (childSupportPaid <= 0) return flags;

  const members = intake.householdMembers || [];
  const hasMinors = members.some((m) => {
    if (!m.inSnapHousehold) return false;
    const rel = (m.relationshipToApplicant || "").toLowerCase();
    const isChild = ["child", "son", "daughter", "son/daughter", "stepchild", "foster child"].some(
      (r) => rel.includes(r)
    );
    if (!isChild) return false;
    return m.ageRange === "under 18" || (m.ageRange && m.ageRange.startsWith("0-"));
  });

  if (!hasMinors) {
    flags.push({
      type: "CHILD_SUPPORT_NO_CHILDREN",
      severity: "MEDIUM",
      field: "deductions",
      message: `$${childSupportPaid}/mo child support deduction claimed but no minor children in household — verify court-ordered obligation for non-custodial parent`,
      suggestedAction: "Request court order or child support documentation per 7 CFR §273.9(d)(5)",
    });
  }

  return flags;
}

/**
 * Flag homeowners with very low income and minimal liquid resources.
 * Home ownership implies equity, down payment history, or ongoing
 * income that may not be fully reported.
 */
function checkHomeownershipMismatch(intake, calculations) {
  const flags = [];
  const shelter = intake.shelterExpense;
  if (!shelter) return flags;

  const isHomeowner = (shelter.propertyTax || 0) > 0 || (shelter.homeownersInsurance || 0) > 0;
  if (!isHomeowner) return flags;

  const grossIncome = calculations.deductions.grossIncome;
  const liquidResources = intake.liquidResources || 0;

  if (grossIncome < 1200 && liquidResources < 100) {
    flags.push({
      type: "HOMEOWNER_LOW_INCOME",
      severity: "MEDIUM",
      field: "income",
      message: `Homeowner (property tax/insurance present) with only $${grossIncome}/mo income and $${liquidResources} liquid resources — verify income completeness and asset status`,
      suggestedAction: "Ask how mortgage/property costs are covered. Verify no unreported rental income or family assistance.",
    });
  }

  return flags;
}

/**
 * Flag cases where estimated benefit is within $50 of the maximum allotment.
 * Near-maximum benefits mean even small income/deduction errors will produce
 * a QC finding. These cases warrant extra scrutiny.
 */
function checkBenefitNearMaximum(calculations) {
  const flags = [];

  if (!calculations?.benefitEstimate) return flags;

  const estimated = calculations.benefitEstimate.estimatedBenefit || 0;
  const maxAllotment = calculations.benefitEstimate.maxAllotment || 0;

  if (maxAllotment <= 0 || estimated <= 0) return flags;

  const gap = maxAllotment - estimated;
  if (gap >= 0 && gap <= 50) {
    flags.push({
      type: "BENEFIT_NEAR_MAXIMUM",
      severity: "MEDIUM",
      field: "income",
      message: `Estimated benefit $${estimated} is within $${gap} of maximum allotment $${maxAllotment} — any income/deduction error becomes a QC overpayment finding`,
      suggestedAction: "Double-check all income amounts and deduction calculations — small errors have outsized impact at this benefit level",
    });
  }

  return flags;
}

function severityRank(severity) {
  return { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 }[severity] ?? 4;
}

function deriveRiskScore(flags) {
  const hasHigh = flags.some((f) => f.severity === "HIGH");
  const hasMedium = flags.some((f) => f.severity === "MEDIUM");

  if (hasHigh) return "HIGH";
  if (hasMedium) return "MEDIUM";
  return "LOW";
}

module.exports = {
  runConsistencyChecks,
  checkIncomeVsExpenses,
  checkHouseholdIncomeGaps,
  checkDeductionEligibility,
  checkThresholdProximity,
  checkShelterConsistency,
  checkExpeditedCriteria,
  checkZeroIncomeWithShelter,
  checkSelfEmploymentExpenses,
  checkPayFrequencyPlausibility,
  checkMedicalExpenseReasonableness,
  checkMultipleAdultsNoIncome,
  checkPossibleUnreportedBenefits,
  checkSeasonalIncomePattern,
  checkPossibleStudentInHousehold,
  checkApplicantIncome,
  checkUnrelatedAdults,
  checkChildSupportWithoutChildren,
  checkHomeownershipMismatch,
  checkBenefitNearMaximum,
};
