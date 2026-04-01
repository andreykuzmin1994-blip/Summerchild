/**
 * Data Validator — validates structured data extracted from AI responses
 * before writing to the database. Prevents hallucinated or invalid data.
 */

function validateIncomeEntry(entry) {
  const errors = [];

  if (typeof entry.gross_amount_per_period !== "number" || entry.gross_amount_per_period < 0) {
    errors.push("Invalid income amount: must be a non-negative number");
  }
  if (entry.gross_amount_per_period > 25000) {
    errors.push("Unusually high per-period income — flagging for manual review");
  }
  if (!["WEEKLY", "BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"].includes(entry.pay_frequency)) {
    errors.push("Invalid pay frequency");
  }
  if (entry.income_type === "SELF_EMPLOYMENT") {
    if (entry.self_employment_expenses > entry.self_employment_gross) {
      errors.push("Business expenses exceed gross receipts — verify");
    }
  }

  return errors;
}

function validateHouseholdMember(member) {
  const errors = [];

  if (!member.first_name || member.first_name.length < 1) {
    errors.push("Missing member name");
  }
  if (member.dob && new Date(member.dob) > new Date()) {
    errors.push("Date of birth is in the future");
  }
  if (typeof member.purchases_and_prepares_together !== "boolean") {
    errors.push("Purchase-and-prepare status not determined");
  }

  return errors;
}

function validateApplicant(applicant) {
  const errors = [];

  if (!applicant.first_name || applicant.first_name.length < 1) {
    errors.push("Missing applicant first name");
  }
  if (!applicant.last_name || applicant.last_name.length < 1) {
    errors.push("Missing applicant last name");
  }
  if (applicant.ssn_last_four && !/^\d{4}$/.test(applicant.ssn_last_four)) {
    errors.push("SSN last four must be exactly 4 digits");
  }
  if (applicant.address_zip && !/^\d{5}$/.test(applicant.address_zip)) {
    errors.push("ZIP code must be exactly 5 digits");
  }
  if (applicant.email && !/^[\w.-]+@[\w.-]+\.\w+$/.test(applicant.email)) {
    errors.push("Invalid email format");
  }

  return errors;
}

function validateShelterExpense(shelter) {
  const errors = [];

  if (shelter.rent_or_mortgage < 0) {
    errors.push("Rent/mortgage cannot be negative");
  }
  if (shelter.rent_or_mortgage > 10000) {
    errors.push("Unusually high rent/mortgage — verify");
  }
  if (!["HEATING_COOLING", "BASIC", "PHONE_ONLY", "NONE"].includes(shelter.utility_type)) {
    errors.push("Invalid utility type");
  }

  return errors;
}

/**
 * Validate extracted data from AI response.
 * Returns { valid: boolean, errors: string[] }
 */
function validateExtractedData(dataBlock) {
  const field = dataBlock.field;
  let errors = [];

  switch (field) {
    case "income_source":
      errors = validateIncomeEntry({
        gross_amount_per_period: dataBlock.gross_per_period,
        pay_frequency: dataBlock.pay_frequency?.toUpperCase(),
        income_type: dataBlock.income_type?.toUpperCase(),
        self_employment_gross: dataBlock.self_employment_gross,
        self_employment_expenses: dataBlock.self_employment_expenses,
      });
      break;
    case "household_member":
      errors = validateHouseholdMember({
        first_name: dataBlock.first_name,
        dob: dataBlock.dob,
        purchases_and_prepares_together: dataBlock.purchases_and_prepares_together,
      });
      break;
    case "applicant_info":
      errors = validateApplicant(dataBlock);
      break;
    case "shelter_expense":
      errors = validateShelterExpense({
        rent_or_mortgage: dataBlock.rent || 0,
        utility_type: dataBlock.utility_type?.toUpperCase(),
      });
      break;
    default:
      // Generic validation — ensure value exists
      if (dataBlock.value === undefined && dataBlock.value !== 0) {
        // Allow fields that have other named properties
        const keys = Object.keys(dataBlock).filter((k) => k !== "field");
        if (keys.length === 0) {
          errors.push(`No value provided for field: ${field}`);
        }
      }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateIncomeEntry,
  validateHouseholdMember,
  validateApplicant,
  validateShelterExpense,
  validateExtractedData,
};
