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

  if (!member.display_name || member.display_name.length < 1) {
    errors.push("Missing member display name");
  }
  if (!member.relationship || member.relationship.length < 1) {
    errors.push("Missing relationship to applicant");
  }
  if (typeof member.purchases_and_prepares_together !== "boolean") {
    errors.push("Purchase-and-prepare status not determined");
  }

  return errors;
}

function validateApplicant(applicant) {
  const errors = [];

  if (!applicant.display_name || applicant.display_name.length < 1) {
    errors.push("Missing applicant display name");
  }

  return errors;
}

/**
 * Validate displayName is in "FirstName L." format only.
 * Prevents full names from being stored (PII minimization).
 */
function validateDisplayName(displayName) {
  const errors = [];
  if (!displayName || displayName.length < 2) {
    errors.push("Display name is required (minimum 2 characters)");
    return errors;
  }
  if (displayName.length > 50) {
    errors.push("Display name too long — use first name and last initial only");
  }
  // Allow: "Maria G.", "Maria G", "Jean-Pierre L.", "Mary Jo K."
  if (!/^[A-Za-z][A-Za-z' -]+\s[A-Z]\.?$/.test(displayName)) {
    errors.push("Display name must be in 'FirstName LastInitial' format (e.g., 'Maria G.')");
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
        display_name: dataBlock.display_name,
        relationship: dataBlock.relationship,
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
  validateDisplayName,
  validateShelterExpense,
  validateExtractedData,
};
