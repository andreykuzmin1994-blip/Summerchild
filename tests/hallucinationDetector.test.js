import { describe, it, expect } from "vitest";
import { detectHallucinations } from "../src/services/aiHallucinationDetector.js";

describe("AI Hallucination Detector", () => {
  const makeConversation = (...userMessages) =>
    userMessages.flatMap((msg) => [
      { role: "user", content: msg },
      { role: "assistant", content: "Thank you for that information." },
    ]);

  describe("Income source grounding", () => {
    it("passes when employer and amount are mentioned by user", () => {
      const conversation = makeConversation(
        "I work at Target and make $800 every two weeks"
      );
      const extracted = [
        { field: "income_source", employer: "Target", gross_per_period: 800 },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings).toHaveLength(0);
    });

    it("flags when employer is not mentioned by user", () => {
      const conversation = makeConversation("I work part-time and earn $500 a week");
      const extracted = [
        { field: "income_source", employer: "Walmart", gross_per_period: 500 },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].type).toBe("POTENTIAL_HALLUCINATION");
      expect(warnings[0].issues.some((i) => i.includes("Walmart"))).toBe(true);
    });

    it("flags when income amount is not mentioned by user", () => {
      const conversation = makeConversation("I work at Target");
      const extracted = [
        { field: "income_source", employer: "Target", gross_per_period: 1500 },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].issues.some((i) => i.includes("$1500"))).toBe(true);
    });
  });

  describe("Household member grounding", () => {
    it("passes when member name is mentioned by user", () => {
      const conversation = makeConversation("My daughter Sarah lives with me");
      const extracted = [
        { field: "household_member", display_name: "Sarah J.", relationship: "daughter" },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings).toHaveLength(0);
    });

    it("flags when member name is not mentioned by user", () => {
      const conversation = makeConversation("I live with my daughter");
      const extracted = [
        { field: "household_member", display_name: "Jessica M.", relationship: "daughter" },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].field).toBe("household_member");
    });
  });

  describe("Shelter expense grounding", () => {
    it("passes when rent amount is mentioned by user", () => {
      const conversation = makeConversation("My rent is $1200 per month");
      const extracted = [{ field: "shelter_rent", rent: 1200 }];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings).toHaveLength(0);
    });

    it("flags when rent amount is not mentioned by user", () => {
      const conversation = makeConversation("I pay rent monthly");
      const extracted = [{ field: "shelter_rent", rent: 950 }];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("returns empty array for no extracted data", () => {
      const conversation = makeConversation("Hello");
      expect(detectHallucinations(conversation, [])).toHaveLength(0);
      expect(detectHallucinations(conversation, null)).toHaveLength(0);
    });

    it("ignores fields without grounding checks (dependent_care, etc.)", () => {
      const conversation = makeConversation("I pay $200 for childcare");
      const extracted = [{ field: "dependent_care", value: 200 }];

      const warnings = detectHallucinations(conversation, extracted);
      expect(warnings).toHaveLength(0);
    });

    it("handles short/empty employer names gracefully", () => {
      const conversation = makeConversation("I work and earn $500 weekly");
      const extracted = [
        { field: "income_source", employer: "", gross_per_period: 500 },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      // Should not flag on empty employer
      const employerWarnings = warnings.filter((w) =>
        w.issues.some((i) => i.includes("Employer"))
      );
      expect(employerWarnings).toHaveLength(0);
    });

    it("checks amounts with and without decimal .00", () => {
      const conversation = makeConversation("I make $1000 per month");
      const extracted = [
        { field: "income_source", employer: "test", gross_per_period: 1000.00 },
      ];

      const warnings = detectHallucinations(conversation, extracted);
      // Should find "1000" in the conversation
      const amountWarnings = warnings.filter((w) =>
        w.issues.some((i) => i.includes("amount"))
      );
      expect(amountWarnings).toHaveLength(0);
    });
  });
});
