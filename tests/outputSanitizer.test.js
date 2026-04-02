import { describe, it, expect } from "vitest";

const {
  sanitizeForDisplay,
  validateDataBlockCount,
  sanitizeAIResponse,
  MAX_DATA_BLOCKS_PER_RESPONSE,
} = require("../src/middleware/outputSanitizer");

describe("sanitizeForDisplay", () => {
  it("escapes HTML special characters", () => {
    expect(sanitizeForDisplay("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;"
    );
  });

  it("escapes ampersands", () => {
    expect(sanitizeForDisplay("A & B")).toBe("A &amp; B");
  });

  it("escapes quotes", () => {
    expect(sanitizeForDisplay('He said "hello"')).toBe("He said &quot;hello&quot;");
  });

  it("preserves normal SNAP-related text", () => {
    expect(sanitizeForDisplay("I make $1200 biweekly")).toBe("I make $1200 biweekly");
  });

  it("handles empty and non-string inputs", () => {
    expect(sanitizeForDisplay("")).toBe("");
    expect(sanitizeForDisplay(null)).toBe("");
    expect(sanitizeForDisplay(undefined)).toBe("");
    expect(sanitizeForDisplay(123)).toBe("");
  });
});

describe("validateDataBlockCount", () => {
  it("allows normal responses with few data blocks", () => {
    const response = 'Hello! <!--CUSHION_DATA:{"field":"household_member","display_name":"John"}-->';
    expect(validateDataBlockCount(response).safe).toBe(true);
    expect(validateDataBlockCount(response).count).toBe(1);
  });

  it("allows responses with no data blocks", () => {
    const response = "Let me ask about your income.";
    const result = validateDataBlockCount(response);
    expect(result.safe).toBe(true);
    expect(result.count).toBe(0);
  });

  it("flags excessive data blocks as unsafe", () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      `<!--CUSHION_DATA:{"field":"household_member","display_name":"Member ${i}"}-->`
    ).join("\n");
    const result = validateDataBlockCount(blocks);
    expect(result.safe).toBe(false);
    expect(result.count).toBe(10);
  });

  it("allows up to MAX_DATA_BLOCKS_PER_RESPONSE blocks", () => {
    const blocks = Array.from({ length: MAX_DATA_BLOCKS_PER_RESPONSE }, (_, i) =>
      `<!--CUSHION_DATA:{"field":"household_member","display_name":"Member ${i}"}-->`
    ).join("\n");
    const result = validateDataBlockCount(blocks);
    expect(result.safe).toBe(true);
  });
});

describe("sanitizeAIResponse", () => {
  it("preserves valid CUSHION_DATA blocks", () => {
    const response = 'Hello! <!--CUSHION_DATA:{"field":"shelter_rent","value":1200}-->';
    expect(sanitizeAIResponse(response)).toBe(response);
  });

  it("strips data blocks with nested HTML comments (injection attempt)", () => {
    const response = '<!--CUSHION_DATA:{"field":"shelter_rent","value":1200}<!-- injected -->-->';
    const cleaned = sanitizeAIResponse(response);
    expect(cleaned).not.toContain("CUSHION_DATA");
  });

  it("strips data blocks with script tags", () => {
    const response = '<!--CUSHION_DATA:<script>alert(1)</script>-->';
    const cleaned = sanitizeAIResponse(response);
    expect(cleaned).not.toContain("script");
  });

  it("strips data blocks with invalid JSON", () => {
    const response = "<!--CUSHION_DATA:not valid json-->";
    const cleaned = sanitizeAIResponse(response);
    expect(cleaned).not.toContain("CUSHION_DATA");
  });

  it("handles non-string input", () => {
    expect(sanitizeAIResponse(null)).toBe("");
    expect(sanitizeAIResponse(undefined)).toBe("");
    expect(sanitizeAIResponse(123)).toBe("");
  });

  it("preserves surrounding text when stripping bad blocks", () => {
    const response = "Your rent is $1200. <!--CUSHION_DATA:bad json--> Thank you!";
    const cleaned = sanitizeAIResponse(response);
    expect(cleaned).toContain("Your rent is $1200.");
    expect(cleaned).toContain("Thank you!");
  });
});
