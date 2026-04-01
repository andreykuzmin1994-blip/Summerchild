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
        first_name: "Jane",
        dob: "1990-05-15",
        purchases_and_prepares_together: true,
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects missing name", () => {
      const errors = validateHouseholdMember({
        first_name: "",
        purchases_and_prepares_together: true,
      });
      expect(errors).toContain("Missing member name");
    });

    it("rejects future DOB", () => {
      const errors = validateHouseholdMember({
        first_name: "Baby",
        dob: "2099-01-01",
        purchases_and_prepares_together: true,
      });
      expect(errors).toContain("Date of birth is in the future");
    });
  });

  describe("validateApplicant", () => {
    it("accepts valid applicant", () => {
      const errors = validateApplicant({
        first_name: "John",
        last_name: "Smith",
        ssn_last_four: "1234",
        address_zip: "30301",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects invalid SSN last four", () => {
      const errors = validateApplicant({
        first_name: "John",
        last_name: "Smith",
        ssn_last_four: "12",
      });
      expect(errors).toContain("SSN last four must be exactly 4 digits");
    });

    it("rejects invalid ZIP", () => {
      const errors = validateApplicant({
        first_name: "John",
        last_name: "Smith",
        address_zip: "123",
      });
      expect(errors).toContain("ZIP code must be exactly 5 digits");
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
