import { describe, it, expect, beforeEach } from "vitest";
import { PIIStripper } from "../src/middleware/piiStripper.js";

describe("PIIStripper", () => {
  let stripper;

  beforeEach(() => {
    stripper = new PIIStripper();
  });

  describe("SSN detection", () => {
    it("strips SSN with dashes (123-45-6789)", () => {
      expect(stripper.strip("My SSN is 123-45-6789")).toContain("[REDACTED]");
      expect(stripper.strip("My SSN is 123-45-6789")).not.toContain("123-45-6789");
    });

    it("strips SSN without dashes (123456789)", () => {
      expect(stripper.strip("My SSN is 123456789")).toContain("[REDACTED]");
      expect(stripper.strip("My SSN is 123456789")).not.toContain("123456789");
    });

    it("strips SSN with spaces (123 45 6789)", () => {
      expect(stripper.strip("My social is 123 45 6789")).toContain("[REDACTED]");
      expect(stripper.strip("My social is 123 45 6789")).not.toContain("123 45 6789");
    });

    it("does not strip 9-digit numbers in context (zip codes, amounts)", () => {
      // Short numbers should not be stripped
      expect(stripper.strip("My zip is 30301")).toBe("My zip is 30301");
    });
  });

  describe("Phone number detection", () => {
    it("strips (404) 555-0123 format", () => {
      expect(stripper.strip("Call (404) 555-0123")).toContain("[REDACTED]");
    });

    it("strips 404-555-0123 format", () => {
      expect(stripper.strip("Call 404-555-0123")).toContain("[REDACTED]");
    });

    it("strips 404.555.0123 format", () => {
      expect(stripper.strip("Call 404.555.0123")).toContain("[REDACTED]");
    });

    it("strips +1-404-555-0123 format", () => {
      expect(stripper.strip("Call +1-404-555-0123")).toContain("[REDACTED]");
    });

    it("strips phone with extension", () => {
      expect(stripper.strip("Call 404-555-0123 ext 101")).toContain("[REDACTED]");
    });

    it("strips 404 555 0123 format (spaces)", () => {
      expect(stripper.strip("Call 404 555 0123")).toContain("[REDACTED]");
    });
  });

  describe("Address detection", () => {
    it("strips standard street address", () => {
      expect(stripper.strip("I live at 123 Main Street")).toContain("[REDACTED]");
    });

    it("strips abbreviated street suffixes", () => {
      expect(stripper.strip("I live at 456 Oak Ave")).toContain("[REDACTED]");
    });

    it("strips Boulevard addresses", () => {
      expect(stripper.strip("My address is 789 Peachtree Boulevard")).toContain("[REDACTED]");
    });

    it("strips Drive addresses", () => {
      expect(stripper.strip("I stay at 100 Pine Drive")).toContain("[REDACTED]");
    });

    it("strips Court addresses", () => {
      expect(stripper.strip("We live at 55 Elm Court")).toContain("[REDACTED]");
    });
  });

  describe("Email detection", () => {
    it("strips standard email", () => {
      expect(stripper.strip("Email me at john@example.com")).toContain("[REDACTED]");
      expect(stripper.strip("Email me at john@example.com")).not.toContain("john@example.com");
    });

    it("strips email with + addressing", () => {
      expect(stripper.strip("My email is user+tag@domain.com")).toContain("[REDACTED]");
    });

    it("strips email with subdomain", () => {
      expect(stripper.strip("Contact me at user@mail.domain.co.uk")).toContain("[REDACTED]");
    });
  });

  describe("Name mappings", () => {
    it("replaces mapped names with placeholders", () => {
      stripper.addMapping("Maria", "[APPLICANT]");
      expect(stripper.strip("My name is Maria")).toBe("My name is [APPLICANT]");
    });

    it("restores names in AI responses", () => {
      stripper.addMapping("Maria", "[APPLICANT]");
      expect(stripper.restore("Hello [APPLICANT], how are you?")).toBe("Hello Maria, how are you?");
    });

    it("ignores empty or single-char mappings", () => {
      stripper.addMapping("", "[EMPTY]");
      stripper.addMapping("A", "[A]");
      expect(stripper.mappings.size).toBe(0);
    });
  });

  describe("Conversation stripping", () => {
    it("strips PII from all messages in conversation history", () => {
      stripper.addMapping("Maria", "[APPLICANT]");
      const messages = [
        { role: "user", content: "My name is Maria and my SSN is 123-45-6789" },
        { role: "assistant", content: "Hello Maria, I can help you" },
      ];
      const stripped = stripper.stripConversation(messages);
      expect(stripped[0].content).not.toContain("123-45-6789");
      expect(stripped[0].content).toContain("[APPLICANT]");
    });
  });

  describe("Welfare ID detection", () => {
    it("strips state welfare ID numbers", () => {
      expect(stripper.strip("My case number is GA1234567")).toContain("[REDACTED]");
    });
  });

  describe("Non-PII should not be stripped", () => {
    it("preserves dollar amounts", () => {
      expect(stripper.strip("I make $1,200 per month")).toBe("I make $1,200 per month");
    });

    it("preserves normal conversation text", () => {
      const text = "I work at Target and earn $15 per hour, 40 hours a week";
      expect(stripper.strip(text)).toBe(text);
    });

    it("preserves household descriptions", () => {
      const text = "I live with my wife and 2 kids";
      expect(stripper.strip(text)).toBe(text);
    });
  });
});
