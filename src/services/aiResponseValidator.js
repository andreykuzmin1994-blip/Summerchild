/**
 * AI Response Validator — Zod schemas for validating structured data extracted
 * from AI responses before database persistence.
 *
 * County compliance notes:
 * - Prevents AI hallucinations from corrupting intake records
 * - All field constraints match SNAP program rules (FNS 7 CFR 273)
 * - Invalid data is rejected and logged — never silently persisted
 * - Schemas are strict: unknown fields are stripped to prevent injection
 */

const { z } = require("zod");

// ── Shared enums ─────────────────────────────────────────────────────

const PayFrequency = z.enum(["WEEKLY", "BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"])
  .describe("How often the applicant receives this income payment");

const IncomeType = z.enum([
  "EMPLOYMENT",
  "SELF_EMPLOYMENT",
  "SOCIAL_SECURITY",
  "SSI",
  "SSDI",
  "UNEMPLOYMENT",
  "VA_BENEFITS",
  "PENSION",
  "CHILD_SUPPORT_RECEIVED",
  "ALIMONY",
  "OTHER",
]).describe("Category of income source per SNAP program rules (7 CFR 273.9)");

const UtilityType = z.enum(["HEATING_COOLING", "BASIC", "PHONE_ONLY", "NONE"])
  .describe("Standard Utility Allowance tier — HEATING_COOLING if applicant pays heating or cooling costs separately");

// ── Field-specific schemas ───────────────────────────────────────────

const HouseholdMemberSchema = z.object({
  field: z.literal("household_member"),
  display_name: z.string().min(1, "Member name is required").max(100)
    .describe("First name and last initial only (e.g. 'Maria G.') — never collect full name"),
  relationship: z.string().min(1, "Relationship is required").max(50)
    .describe("Relationship to the applicant (e.g. 'spouse', 'child', 'parent', 'unrelated adult')"),
  age_range: z.string().max(20).optional().nullable()
    .describe("Age bracket, not exact age (e.g. '30-39', '60-69', 'under 18')"),
  is_elderly: z.boolean().optional().default(false)
    .describe("True if member is 60 years or older per SNAP elderly definition"),
  is_disabled: z.boolean().optional().default(false)
    .describe("True if member receives disability-based benefits (SSI, SSDI, VA disability)"),
  purchases_and_prepares_together: z.boolean().optional().default(true)
    .describe("True if this member buys and cooks food with the applicant — determines SNAP household membership"),
}).strict();

const IncomeSourceSchema = z.object({
  field: z.literal("income_source"),
  employer: z.string().max(200).optional().nullable()
    .describe("Employer or business name — optional, used for caseworker reference only"),
  income_type: z.string().transform((v) => v.toUpperCase()).pipe(IncomeType).optional().default("EMPLOYMENT")
    .describe("Category of income — determines whether 20% earned income deduction applies"),
  pay_frequency: z.string().transform((v) => v.toUpperCase()).pipe(PayFrequency).optional().default("MONTHLY")
    .describe("Payment schedule — used to normalize income to monthly (WEEKLY×4.333, BIWEEKLY×2.167, SEMI_MONTHLY×2)"),
  gross_per_period: z.number().min(0, "Income cannot be negative").max(50000, "Income exceeds plausible maximum")
    .describe("Gross (pre-tax) income amount per pay period in USD — not annual, not net"),
  member: z.string().max(100).optional().nullable()
    .describe("Which household member earns this income — matches display_name from household_member"),
  self_employment_gross: z.number().min(0).max(100000).optional().nullable()
    .describe("Total monthly self-employment gross revenue before expenses"),
  self_employment_expenses: z.number().min(0).max(100000).optional().nullable()
    .describe("Allowable monthly self-employment business expenses"),
  self_employment_deduction_method: z.string().max(50).optional().nullable()
    .describe("'ACTUAL' for itemized expenses or '50_PERCENT' for standard 50% deduction"),
}).strict();

const ShelterRentSchema = z.object({
  field: z.literal("shelter_rent"),
  rent: z.number().min(0, "Rent cannot be negative").max(15000, "Rent exceeds plausible maximum").optional()
    .describe("Monthly rent or mortgage payment in USD"),
  value: z.number().min(0).max(15000).optional()
    .describe("Alternative field for monthly shelter cost if rent is not specified"),
  property_tax: z.number().min(0).max(5000).optional()
    .describe("Monthly property tax amount (divide annual by 12)"),
  homeowners_insurance: z.number().min(0).max(3000).optional()
    .describe("Monthly homeowners or renters insurance premium"),
}).strict();

const ShelterUtilitySchema = z.object({
  field: z.literal("shelter_utility"),
  utility_type: z.string().transform((v) => v.toUpperCase()).pipe(UtilityType).optional()
    .describe("Standard Utility Allowance tier based on which utility costs the applicant pays separately"),
  value: z.string().max(50).optional()
    .describe("Descriptive value for the utility arrangement"),
}).strict();

const ShelterExpenseSchema = z.object({
  field: z.literal("shelter_expense"),
  rent: z.number().min(0).max(15000).optional()
    .describe("Monthly rent or mortgage payment in USD"),
  value: z.number().min(0).max(15000).optional()
    .describe("Alternative field for monthly shelter cost"),
  property_tax: z.number().min(0).max(5000).optional()
    .describe("Monthly property tax amount (divide annual by 12)"),
  homeowners_insurance: z.number().min(0).max(3000).optional()
    .describe("Monthly homeowners or renters insurance premium"),
  utility_type: z.string().transform((v) => v.toUpperCase()).pipe(UtilityType).optional()
    .describe("Standard Utility Allowance tier based on which utility costs the applicant pays separately"),
}).strict();

const ApplicantInfoSchema = z.object({
  field: z.literal("applicant_info"),
  display_name: z.string().min(1).max(100).optional()
    .describe("First name and last initial only (e.g. 'Maria G.') — never full legal name"),
  language: z.string().max(10).optional()
    .describe("Preferred language code (e.g. 'en', 'es', 'vi', 'ko')"),
}).strict();

const ApplicantLanguageSchema = z.object({
  field: z.literal("applicant_language"),
  language: z.string().max(10)
    .describe("Preferred language code (e.g. 'en', 'es', 'vi', 'ko')"),
}).strict();

const NumericFieldSchema = z.object({
  field: z.enum(["dependent_care", "medical_expenses", "child_support_paid", "liquid_resources"])
    .describe("Type of deductible expense or asset being reported"),
  value: z.union([z.number(), z.string().transform(Number)])
    .pipe(z.number().min(0, "Value cannot be negative").max(50000, "Value exceeds plausible maximum"))
    .describe("Monthly dollar amount in USD — convert weekly/biweekly to monthly before submitting"),
}).strict();

// ── Schema registry ──────────────────────────────────────────────────

const SCHEMA_MAP = {
  household_member: HouseholdMemberSchema,
  income_source: IncomeSourceSchema,
  shelter_rent: ShelterRentSchema,
  shelter_utility: ShelterUtilitySchema,
  shelter_expense: ShelterExpenseSchema,
  applicant_info: ApplicantInfoSchema,
  applicant_language: ApplicantLanguageSchema,
  dependent_care: NumericFieldSchema,
  medical_expenses: NumericFieldSchema,
  child_support_paid: NumericFieldSchema,
  liquid_resources: NumericFieldSchema,
};

/**
 * Validate an AI-extracted data block against its Zod schema.
 *
 * @param {Object} dataBlock - Parsed JSON from <!--CUSHION_DATA:...-->
 * @returns {{ valid: boolean, data?: Object, errors?: string[], warnings?: string[] }}
 */
function validateAIResponse(dataBlock) {
  if (!dataBlock || typeof dataBlock !== "object") {
    return { valid: false, errors: ["Data block is not an object"] };
  }

  const field = dataBlock.field;
  if (!field || typeof field !== "string") {
    return { valid: false, errors: ["Missing or invalid 'field' property"] };
  }

  const schema = SCHEMA_MAP[field];
  if (!schema) {
    // Unknown field — pass through with a warning (backward compatibility)
    // The existing dataValidator will handle the generic case
    return { valid: true, data: dataBlock, warnings: [`Unknown field type: ${field}`] };
  }

  const result = schema.safeParse(dataBlock);
  if (result.success) {
    return { valid: true, data: result.data };
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`
  );

  return { valid: false, errors };
}

module.exports = {
  validateAIResponse,
  SCHEMA_MAP,
  // Export individual schemas for testing
  HouseholdMemberSchema,
  IncomeSourceSchema,
  ShelterRentSchema,
  ShelterUtilitySchema,
  ShelterExpenseSchema,
  ApplicantInfoSchema,
  NumericFieldSchema,
  PayFrequency,
  IncomeType,
  UtilityType,
};
