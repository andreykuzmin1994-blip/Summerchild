import { describe, it, expect } from "vitest";

const {
  SECTION_CONTEXT,
  validateFieldsForSection,
  scoreSectionRelevance,
  checkForbiddenContent,
  validateConversationContext,
} = require("../src/middleware/conversationContext");

// ── Field validation per section ────────────────────────────────────

describe("validateFieldsForSection", () => {
  describe("WELCOME section", () => {
    it("accepts applicant_info fields", () => {
      const result = validateFieldsForSection("WELCOME", [
        { field: "applicant_info", display_name: "Maria G." },
      ]);
      expect(result.valid).toBe(true);
      expect(result.expectedFields).toContain("applicant_info");
    });

    it("accepts applicant_language fields", () => {
      const result = validateFieldsForSection("WELCOME", [
        { field: "applicant_language", language: "es" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("accepts adjacent household_member field (section transition)", () => {
      const result = validateFieldsForSection("WELCOME", [
        { field: "household_member", display_name: "Member 1" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("flags income_source as unexpected during WELCOME", () => {
      const result = validateFieldsForSection("WELCOME", [
        { field: "income_source", employer: "Walmart" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.unexpectedFields).toContain("income_source");
    });

    it("flags shelter_rent as unexpected during WELCOME", () => {
      const result = validateFieldsForSection("WELCOME", [
        { field: "shelter_rent", value: 1200 },
      ]);
      expect(result.valid).toBe(false);
      expect(result.unexpectedFields).toContain("shelter_rent");
    });
  });

  describe("HOUSEHOLD section", () => {
    it("accepts household_member fields", () => {
      const result = validateFieldsForSection("HOUSEHOLD", [
        { field: "household_member", display_name: "James", relationship: "spouse" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("accepts adjacent income_source (section transition)", () => {
      const result = validateFieldsForSection("HOUSEHOLD", [
        { field: "income_source", employer: "Target" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("flags shelter_rent as unexpected during HOUSEHOLD", () => {
      const result = validateFieldsForSection("HOUSEHOLD", [
        { field: "shelter_rent", value: 800 },
      ]);
      expect(result.valid).toBe(false);
    });
  });

  describe("INCOME section", () => {
    it("accepts income_source fields", () => {
      const result = validateFieldsForSection("INCOME", [
        { field: "income_source", employer: "Walmart", gross_per_period: 1200 },
      ]);
      expect(result.valid).toBe(true);
    });

    it("accepts adjacent shelter fields (transition to EXPENSES)", () => {
      const result = validateFieldsForSection("INCOME", [
        { field: "shelter_rent", value: 900 },
      ]);
      expect(result.valid).toBe(true);
    });

    it("flags applicant_language as unexpected during INCOME", () => {
      const result = validateFieldsForSection("INCOME", [
        { field: "applicant_language", language: "es" },
      ]);
      expect(result.valid).toBe(false);
    });
  });

  describe("EXPENSES section", () => {
    it("accepts shelter_rent fields", () => {
      const result = validateFieldsForSection("EXPENSES", [
        { field: "shelter_rent", value: 1200 },
      ]);
      expect(result.valid).toBe(true);
    });

    it("accepts shelter_utility fields", () => {
      const result = validateFieldsForSection("EXPENSES", [
        { field: "shelter_utility", utility_type: "HEATING_COOLING" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("accepts dependent_care, medical_expenses, child_support_paid", () => {
      const result = validateFieldsForSection("EXPENSES", [
        { field: "dependent_care", value: 400 },
        { field: "medical_expenses", value: 100 },
        { field: "child_support_paid", value: 200 },
      ]);
      expect(result.valid).toBe(true);
      expect(result.expectedFields).toHaveLength(3);
    });

    it("accepts adjacent income_source (applicant correcting)", () => {
      const result = validateFieldsForSection("EXPENSES", [
        { field: "income_source", employer: "Walmart" },
      ]);
      expect(result.valid).toBe(true);
    });
  });

  describe("REVIEW section", () => {
    it("accepts any data field (corrections allowed)", () => {
      const fields = [
        { field: "household_member" },
        { field: "income_source" },
        { field: "shelter_rent" },
        { field: "dependent_care" },
      ];
      const result = validateFieldsForSection("REVIEW", fields);
      expect(result.valid).toBe(true);
      expect(result.expectedFields).toHaveLength(4);
    });
  });

  describe("edge cases", () => {
    it("returns valid for empty extracted data", () => {
      const result = validateFieldsForSection("INCOME", []);
      expect(result.valid).toBe(true);
    });

    it("returns valid for null extracted data", () => {
      const result = validateFieldsForSection("INCOME", null);
      expect(result.valid).toBe(true);
    });

    it("returns valid for unknown section", () => {
      const result = validateFieldsForSection("UNKNOWN", [{ field: "income_source" }]);
      expect(result.valid).toBe(true);
    });
  });
});

// ── Section-aware relevance scoring ─────────────────────────────────

describe("scoreSectionRelevance", () => {
  it("scores HOUSEHOLD response as relevant when discussing household topics", () => {
    const response = "Thank you! Now I need to know about the other people in your household. Does anyone else live with you? I need to understand who purchases and prepares food together with you.";
    const result = scoreSectionRelevance("HOUSEHOLD", response);
    expect(result.relevant).toBe(true);
    expect(result.section).toBe("HOUSEHOLD");
  });

  it("scores INCOME response as relevant when discussing income topics", () => {
    const response = "Got it. Now let's talk about income. Does anyone in your household have employment income? I need to know about each job — the employer name, how often you're paid, and the gross amount per pay period.";
    const result = scoreSectionRelevance("INCOME", response);
    expect(result.relevant).toBe(true);
  });

  it("scores EXPENSES response as relevant when discussing shelter and utilities", () => {
    const response = "Now let's go over your expenses. How much is your monthly rent or mortgage payment? Do you pay utilities like heating, electric, or just phone service?";
    const result = scoreSectionRelevance("EXPENSES", response);
    expect(result.relevant).toBe(true);
  });

  it("flags off-topic responses in INCOME section", () => {
    const response = "Here is a delicious recipe for pasta carbonara. You will need eggs, bacon, parmesan cheese, and spaghetti. Cook the pasta in salted boiling water until al dente.";
    const result = scoreSectionRelevance("INCOME", response);
    expect(result.relevant).toBe(false);
    expect(result.reason).toContain("INCOME");
  });

  it("flags off-topic responses in HOUSEHOLD section", () => {
    const response = "The weather today is sunny with a high of 75 degrees. Tomorrow there will be scattered thunderstorms with a chance of hail in the afternoon.";
    const result = scoreSectionRelevance("HOUSEHOLD", response);
    expect(result.relevant).toBe(false);
  });

  it("exempts short responses from relevance scoring", () => {
    const result = scoreSectionRelevance("INCOME", "Got it, thank you!");
    expect(result.relevant).toBe(true);
  });

  it("handles null/undefined inputs", () => {
    expect(scoreSectionRelevance("INCOME", null).relevant).toBe(true);
    expect(scoreSectionRelevance("INCOME", undefined).relevant).toBe(true);
    expect(scoreSectionRelevance(null, "test").relevant).toBe(true);
  });
});

// ── Forbidden content detection ─────────────────────────────────────

describe("checkForbiddenContent", () => {
  it("flags eligibility determinations", () => {
    const result = checkForbiddenContent("Based on your information, you are approved for SNAP benefits.");
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("flags requests for PII", () => {
    const result = checkForbiddenContent("What is your Social Security number? I need it for the application.");
    expect(result.clean).toBe(false);
  });

  it("flags AI self-reference", () => {
    const result = checkForbiddenContent("As an AI language model, I cannot process your request.");
    expect(result.clean).toBe(false);
  });

  it("flags system prompt references", () => {
    const result = checkForbiddenContent("My instructions say I should collect this information first.");
    expect(result.clean).toBe(false);
  });

  it("allows normal SNAP intake responses", () => {
    const result = checkForbiddenContent(
      "Thank you, Maria! Now, does anyone else in your household have income from employment or other sources?"
    );
    expect(result.clean).toBe(true);
  });

  it("allows mentioning that the caseworker will determine eligibility", () => {
    const result = checkForbiddenContent(
      "Your caseworker will review all the information we've collected to determine your eligibility."
    );
    expect(result.clean).toBe(true);
  });

  it("handles non-string input", () => {
    expect(checkForbiddenContent(null).clean).toBe(true);
    expect(checkForbiddenContent(undefined).clean).toBe(true);
  });
});

// ── Full context validation ─────────────────────────────────────────

describe("validateConversationContext", () => {
  it("returns ok for valid INCOME section response with income data", () => {
    const result = validateConversationContext(
      "INCOME",
      "Great, so you earn $1,200 biweekly at Walmart. That comes to about $2,600 per month gross income. Does anyone else in your household have employment or other income?",
      [{ field: "income_source", employer: "Walmart", gross_per_period: 1200 }],
    );
    expect(result.ok).toBe(true);
    expect(result.fieldCheck.valid).toBe(true);
    expect(result.relevanceCheck.relevant).toBe(true);
    expect(result.forbiddenCheck.clean).toBe(true);
  });

  it("flags invalid field + off-topic + forbidden content combo", () => {
    const result = validateConversationContext(
      "WELCOME",
      "You are approved for $500 per month in benefits. As an AI, I can confirm this. What is your social security number?",
      [{ field: "income_source", employer: "Fake" }],
    );
    expect(result.ok).toBe(false);
    expect(result.fieldCheck.valid).toBe(false);
    expect(result.forbiddenCheck.clean).toBe(false);
  });

  it("flags unexpected data field but allows relevant text (soft warning)", () => {
    const result = validateConversationContext(
      "WELCOME",
      "Welcome to the SNAP application process! I'm here to help collect information for your caseworker to review.",
      [{ field: "shelter_rent", value: 1200 }],
    );
    expect(result.ok).toBe(false);
    expect(result.fieldCheck.valid).toBe(false);
    expect(result.relevanceCheck.relevant).toBe(true);
    expect(result.forbiddenCheck.clean).toBe(true);
  });

  it("returns ok when no data blocks extracted (just conversation)", () => {
    const result = validateConversationContext(
      "HOUSEHOLD",
      "How many people live in your household? I need to know about each member — their relationship to you and approximate age range.",
      [],
    );
    expect(result.ok).toBe(true);
  });
});

// ── Section context completeness ────────────────────────────────────

describe("SECTION_CONTEXT completeness", () => {
  it("defines all five intake sections", () => {
    expect(SECTION_CONTEXT).toHaveProperty("WELCOME");
    expect(SECTION_CONTEXT).toHaveProperty("HOUSEHOLD");
    expect(SECTION_CONTEXT).toHaveProperty("INCOME");
    expect(SECTION_CONTEXT).toHaveProperty("EXPENSES");
    expect(SECTION_CONTEXT).toHaveProperty("REVIEW");
  });

  it("each section has expectedFields, keywords, and adjacentFields", () => {
    for (const [name, ctx] of Object.entries(SECTION_CONTEXT)) {
      expect(ctx.expectedFields, `${name}.expectedFields`).toBeInstanceOf(Array);
      expect(ctx.expectedFields.length, `${name}.expectedFields should be non-empty`).toBeGreaterThan(0);
      expect(ctx.keywords, `${name}.keywords`).toBeInstanceOf(Array);
      expect(ctx.keywords.length, `${name}.keywords should be non-empty`).toBeGreaterThan(0);
      expect(ctx, `${name} should have adjacentFields`).toHaveProperty("adjacentFields");
    }
  });

  it("all CUSHION_DATA field types are covered across sections", () => {
    const allFields = new Set();
    for (const ctx of Object.values(SECTION_CONTEXT)) {
      for (const f of [...ctx.expectedFields, ...(ctx.adjacentFields || [])]) {
        allFields.add(f);
      }
    }

    // Every known data field type should appear in at least one section
    const requiredFields = [
      "applicant_info", "applicant_language", "household_member",
      "income_source", "shelter_expense", "shelter_rent", "shelter_utility",
      "dependent_care", "medical_expenses", "child_support_paid", "liquid_resources",
    ];
    for (const field of requiredFields) {
      expect(allFields.has(field), `${field} should be covered by at least one section`).toBe(true);
    }
  });
});
