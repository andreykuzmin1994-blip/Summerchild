import { describe, it, expect } from "vitest";

const {
  validateIncomeEntry,
  validateHouseholdMember,
  validateApplicant,
  validateShelterExpense,
  validateExtractedData,
} = require("../src/services/dataValidator");

describe("dataValidator", () => {
  describe("validateIncomeEntry", () => {
    it("accepts valid income entry", () => {
      const errors = validateIncomeEntry({
        gross_amount_per_period: 1200,
        pay_frequency: "BIWEEKLY",
        income_type: "EMPLOYMENT",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects negative income", () => {
      const errors = validateIncomeEntry({
        gross_amount_per_period: -500,
        pay_frequency: "MONTHLY",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("flags unusually high income", () => {
      const errors = validateIncomeEntry({
        gross_amount_per_period: 30000,
        pay_frequency: "MONTHLY",
      });
      expect(errors).toContain("Unusually high per-period income — flagging for manual review");
    });

    it("rejects invalid pay frequency", () => {
      const errors = validateIncomeEntry({
        gross_amount_per_period: 1000,
        pay_frequency: "DAILY",
      });
      expect(errors).toContain("Invalid pay frequency");
    });

    it("flags self-employment expenses exceeding gross", () => {
      const errors = validateIncomeEntry({
        gross_amount_per_period: 1000,
        pay_frequency: "MONTHLY",
        income_type: "SELF_EMPLOYMENT",
        self_employment_gross: 2000,
        self_employment_expenses: 3000,
      });
      expect(errors).toContain("Business expenses exceed gross receipts — verify");
    });
  });

  describe("validateHouseholdMember", () => {
    it("accepts valid member", () => {
      const errors = validateHouseholdMember({
        display_name: "Member 1",
        relationship: "spouse",
        purchases_and_prepares_together: true,
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects missing display name", () => {
      const errors = validateHouseholdMember({
        display_name: "",
        relationship: "spouse",
        purchases_and_prepares_together: true,
      });
      expect(errors).toContain("Missing member display name");
    });

    it("rejects missing relationship", () => {
      const errors = validateHouseholdMember({
        display_name: "Member 1",
        relationship: "",
        purchases_and_prepares_together: true,
      });
      expect(errors).toContain("Missing relationship to applicant");
    });
  });

  describe("validateApplicant", () => {
    it("accepts valid applicant", () => {
      const errors = validateApplicant({
        display_name: "Maria G.",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects missing display name", () => {
      const errors = validateApplicant({
        display_name: "",
      });
      expect(errors).toContain("Missing applicant display name");
    });
  });

  describe("validateShelterExpense", () => {
    it("accepts valid shelter expense", () => {
      const errors = validateShelterExpense({
        rent_or_mortgage: 1200,
        utility_type: "HEATING_COOLING",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects negative rent", () => {
      const errors = validateShelterExpense({
        rent_or_mortgage: -500,
        utility_type: "BASIC",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("flags unusually high rent", () => {
      const errors = validateShelterExpense({
        rent_or_mortgage: 15000,
        utility_type: "BASIC",
      });
      expect(errors).toContain("Unusually high rent/mortgage — verify");
    });
  });
});
