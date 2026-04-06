import { describe, it, expect } from "vitest";
import {
  validateAIResponse,
  formatValidationErrorsForLLM,
} from "../src/services/aiResponseValidator";
import { extractStructuredData } from "../src/services/aiAssistant";

describe("Self-healing validation", () => {
  describe("formatValidationErrorsForLLM", () => {
    it("produces a prompt with the original data and errors", () => {
      const block = { field: "income_source", gross_per_period: -100 };
      const errors = ["gross_per_period: Income cannot be negative"];

      const prompt = formatValidationErrorsForLLM(block, errors);

      expect(prompt).toContain("validation errors");
      expect(prompt).toContain(JSON.stringify(block));
      expect(prompt).toContain("Income cannot be negative");
      expect(prompt).toContain("<!--CUSHION_DATA:");
    });

    it("includes all errors in the prompt", () => {
      const block = { field: "household_member" };
      const errors = [
        "display_name: Member name is required",
        "relationship: Relationship is required",
      ];

      const prompt = formatValidationErrorsForLLM(block, errors);

      expect(prompt).toContain("Member name is required");
      expect(prompt).toContain("Relationship is required");
    });
  });

  describe("validation + healing flow", () => {
    it("validates a correct income_source block", () => {
      const block = {
        field: "income_source",
        employer: "Walmart",
        pay_frequency: "biweekly",
        gross_per_period: 1147.50,
        income_type: "employment",
        member: "applicant",
      };

      const result = validateAIResponse(block);
      expect(result.valid).toBe(true);
    });

    it("rejects negative income and provides actionable errors", () => {
      const block = {
        field: "income_source",
        gross_per_period: -500,
      };

      const result = validateAIResponse(block);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Income cannot be negative");

      // The error message can be fed to the LLM
      const healPrompt = formatValidationErrorsForLLM(block, result.errors);
      expect(healPrompt).toContain("re-output this data block");
    });

    it("rejects income over plausible maximum", () => {
      const block = {
        field: "income_source",
        gross_per_period: 999999,
      };

      const result = validateAIResponse(block);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("plausible maximum");
    });

    it("rejects household member without display_name", () => {
      const block = {
        field: "household_member",
        relationship: "spouse",
      };

      const result = validateAIResponse(block);
      expect(result.valid).toBe(false);
    });
  });

  describe("extractStructuredData", () => {
    it("extracts valid JSON from CUSHION_DATA tags", () => {
      const response = `Here's your info. <!--CUSHION_DATA:{"field":"shelter_rent","rent":1200}-->`;
      const data = extractStructuredData(response);
      expect(data).toHaveLength(1);
      expect(data[0].field).toBe("shelter_rent");
      expect(data[0].rent).toBe(1200);
    });

    it("extracts multiple data blocks", () => {
      const block1 = '{"field":"income_source","gross_per_period":2000}';
      const block2 = '{"field":"shelter_rent","rent":800}';
      const response = `Got it. <!--CUSHION_DATA:${block1}--> <!--CUSHION_DATA:${block2}-->`;
      const data = extractStructuredData(response);
      expect(data).toHaveLength(2);
    });

    it("skips malformed JSON blocks", () => {
      const response = `<!--CUSHION_DATA:not-json--> <!--CUSHION_DATA:{"field":"shelter_rent","rent":500}-->`;
      const data = extractStructuredData(response);
      expect(data).toHaveLength(1);
    });
  });
});
