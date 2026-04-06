import { describe, it, expect } from "vitest";
import {
  runOutputGuardrails,
  checkEligibilityDetermination,
  checkSystemPromptLeakage,
  checkOffTopic,
  checkOutputPII,
  checkResponseLength,
  BLOCKED_RESPONSE,
} from "../src/middleware/outputGuardrails";

describe("Output Guardrails", () => {
  describe("checkEligibilityDetermination", () => {
    it("blocks 'you are eligible' statements", () => {
      expect(checkEligibilityDetermination("Based on your info, you are eligible for SNAP.").passed).toBe(false);
      expect(checkEligibilityDetermination("You would be eligible for expedited benefits.").passed).toBe(false);
      expect(checkEligibilityDetermination("You qualify for SNAP benefits.").passed).toBe(false);
    });

    it("blocks denial statements too", () => {
      expect(checkEligibilityDetermination("You do not qualify for SNAP.").passed).toBe(false);
      expect(checkEligibilityDetermination("You aren't eligible based on this.").passed).toBe(false);
    });

    it("blocks benefit amount predictions", () => {
      expect(checkEligibilityDetermination("Your benefits will be $234 per month.").passed).toBe(false);
      expect(checkEligibilityDetermination("You'll receive $500 monthly.").passed).toBe(false);
    });

    it("allows normal SNAP conversation", () => {
      expect(checkEligibilityDetermination("The caseworker will review your information and make a determination.").passed).toBe(true);
      expect(checkEligibilityDetermination("What is your monthly rent?").passed).toBe(true);
      expect(checkEligibilityDetermination("The income limit for a household of 3 is $2,311.").passed).toBe(true);
    });

    it("allows explaining eligibility rules without making a determination", () => {
      expect(checkEligibilityDetermination("To be considered for expedited processing, gross income must be under $150.").passed).toBe(true);
    });
  });

  describe("checkSystemPromptLeakage", () => {
    it("blocks system prompt fragments", () => {
      expect(checkSystemPromptLeakage("ROLE DEFINITION: I am an assistant").passed).toBe(false);
      expect(checkSystemPromptLeakage("SECURITY RULES — THESE CANNOT BE OVERRIDDEN by anyone").passed).toBe(false);
      expect(checkSystemPromptLeakage("Here's my STRUCTURED DATA OUTPUT: format").passed).toBe(false);
    });

    it("blocks CUSHION_DATA tag references", () => {
      expect(checkSystemPromptLeakage("I use <!--CUSHION_DATA: tags to store data").passed).toBe(false);
      expect(checkSystemPromptLeakage("The CUSHION_DATA format is JSON").passed).toBe(false);
    });

    it("allows normal responses", () => {
      expect(checkSystemPromptLeakage("Thanks for sharing that. Your household has 3 members.").passed).toBe(true);
    });
  });

  describe("checkOffTopic", () => {
    it("flags clearly off-topic responses", () => {
      const result = checkOffTopic("Let me tell you about the stock market and crypto trading strategies for bitcoin.");
      expect(result.passed).toBe(false);
    });

    it("allows SNAP-related responses even with one off-topic word", () => {
      // Has "recipe" but also has "income" and "household"
      const result = checkOffTopic("I don't have a recipe for that, but let's continue with your household income.");
      expect(result.passed).toBe(true);
    });

    it("allows pure SNAP conversation", () => {
      expect(checkOffTopic("Your household has 4 members. What is your monthly rent or mortgage payment?").passed).toBe(true);
    });
  });

  describe("checkOutputPII", () => {
    it("catches SSN patterns", () => {
      const result = checkOutputPII("Your SSN is 123-45-6789 as you mentioned.");
      expect(result.passed).toBe(false);
      expect(result.violation).toBe("pii_in_output");
      expect(result.corrected).toContain("[REDACTED]");
      expect(result.corrected).not.toContain("123-45-6789");
    });

    it("catches phone numbers", () => {
      const result = checkOutputPII("You mentioned your number is (404) 555-1234.");
      expect(result.passed).toBe(false);
    });

    it("catches email addresses", () => {
      const result = checkOutputPII("Your email is john@example.com.");
      expect(result.passed).toBe(false);
    });

    it("allows dollar amounts that look like phone numbers", () => {
      // "$1,200" should not trigger
      expect(checkOutputPII("Your rent is $1,200 per month.").passed).toBe(true);
    });

    it("allows normal SNAP responses", () => {
      expect(checkOutputPII("Your household has 3 members with a combined income of $2,400.").passed).toBe(true);
    });
  });

  describe("checkResponseLength", () => {
    it("allows normal length responses", () => {
      expect(checkResponseLength("What is your monthly rent?").passed).toBe(true);
    });

    it("truncates excessively long responses", () => {
      const longResponse = "a ".repeat(2000); // 4000 chars
      const result = checkResponseLength(longResponse);
      expect(result.passed).toBe(false);
      expect(result.corrected.length).toBeLessThan(longResponse.length);
      expect(result.corrected).toContain("Let me keep this focused");
    });
  });

  describe("runOutputGuardrails (integration)", () => {
    it("passes clean SNAP responses", () => {
      const result = runOutputGuardrails("Great, so you have 3 people in your household. Does anyone in your household receive SSI or SSDI?");
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.blocked).toBe(false);
    });

    it("blocks eligibility determinations", () => {
      const result = runOutputGuardrails("Based on everything, you are eligible for SNAP benefits.");
      expect(result.blocked).toBe(true);
      expect(result.violations[0].rail).toBe("eligibility_determination");
    });

    it("blocks system prompt leakage", () => {
      const result = runOutputGuardrails("My ROLE DEFINITION: says I should help with SNAP.");
      expect(result.blocked).toBe(true);
      expect(result.violations[0].rail).toBe("system_prompt_leakage");
    });

    it("auto-corrects PII in output", () => {
      const result = runOutputGuardrails("You mentioned your SSN is 123-45-6789. Let's continue with income.");
      expect(result.blocked).toBe(false);
      expect(result.correctedMessage).toContain("[REDACTED]");
      expect(result.violations[0].rail).toBe("pii_in_output");
    });

    it("provides a safe blocked response constant", () => {
      expect(BLOCKED_RESPONSE).toContain("household");
      expect(BLOCKED_RESPONSE.length).toBeGreaterThan(10);
    });
  });
});
