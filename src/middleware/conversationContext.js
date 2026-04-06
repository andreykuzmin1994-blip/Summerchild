/**
 * Conversation Context Guardrail — section-aware AI response validation.
 *
 * The SNAP intake follows a structured flow: WELCOME → HOUSEHOLD → INCOME →
 * EXPENSES → REVIEW. At each stage, there's a narrow set of things the AI
 * should be discussing and a narrow set of data fields it should be extracting.
 *
 * This module defines the "expected envelope" for each section and validates
 * AI responses against it. This is a much stronger signal than generic keyword
 * checking — if we're collecting income data and the AI suddenly produces a
 * shelter_rent block, something is wrong.
 *
 * Three validation axes:
 * 1. Data field validation — are the extracted CUSHION_DATA fields appropriate
 *    for the current section?
 * 2. Response keyword validation — does the AI's message contain vocabulary
 *    relevant to the current section?
 * 3. Forbidden content detection — is the AI discussing things it should never
 *    discuss regardless of section?
 */

// ── Section definitions ─────────────────────────────────────────────

/**
 * Each section defines:
 * - expectedFields: CUSHION_DATA field types that are valid in this section
 * - keywords: terms that should appear in on-topic responses (at least some)
 * - forbiddenPatterns: patterns that should never appear in any response
 */
const SECTION_CONTEXT = {
  WELCOME: {
    expectedFields: ["applicant_info", "applicant_language"],
    keywords: [
      "welcome", "snap", "application", "help", "name", "process",
      "caseworker", "information", "intake", "benefit", "office",
      "question", "begin", "start", "assist", "dfcs",
    ],
    // Allowed spillover: the AI might begin asking about household in the
    // same turn it finishes the welcome. Allow HOUSEHOLD fields as adjacent.
    adjacentFields: ["household_member"],
  },

  HOUSEHOLD: {
    expectedFields: [
      "household_member", "applicant_info", "applicant_language",
    ],
    keywords: [
      "household", "member", "family", "people", "live", "together",
      "spouse", "child", "children", "relationship", "age", "elderly",
      "disabled", "purchase", "prepare", "food", "cook",
    ],
    adjacentFields: ["income_source"],
  },

  INCOME: {
    expectedFields: ["income_source"],
    keywords: [
      "income", "employ", "employer", "wage", "salary", "pay",
      "biweekly", "weekly", "monthly", "job", "work", "earn",
      "self-employment", "business", "social security", "ssi", "ssdi",
      "unemployment", "pension", "benefit", "gross", "amount",
    ],
    adjacentFields: [
      "household_member", "shelter_expense", "shelter_rent", "shelter_utility",
      "dependent_care", "medical_expenses",
    ],
  },

  EXPENSES: {
    expectedFields: [
      "shelter_expense", "shelter_rent", "shelter_utility",
      "dependent_care", "medical_expenses", "child_support_paid",
      "liquid_resources",
    ],
    keywords: [
      "rent", "mortgage", "shelter", "utility", "utilities", "expense",
      "heating", "cooling", "electric", "gas", "phone", "medical",
      "dependent", "care", "child support", "resource", "bank",
      "savings", "property", "insurance", "deduction",
    ],
    adjacentFields: ["income_source"],
  },

  REVIEW: {
    expectedFields: [
      // During review, any field might appear if the applicant corrects something
      "household_member", "income_source",
      "shelter_expense", "shelter_rent", "shelter_utility",
      "dependent_care", "medical_expenses", "child_support_paid",
      "liquid_resources", "applicant_info",
    ],
    keywords: [
      "summary", "review", "confirm", "correct", "change", "accurate",
      "household", "income", "expense", "shelter", "document",
      "everything", "look", "right", "caseworker", "complete",
      "benefit", "eligibility", "next", "interview",
    ],
    adjacentFields: [],
  },
};

// Content that should never appear in any AI response regardless of section
const FORBIDDEN_PATTERNS = [
  // The AI should never claim to make eligibility determinations
  /you (?:are|have been|will be) (?:approved|denied|eligible|ineligible)/i,
  // The AI should never ask for PII
  /(?:what is|provide|give me|enter|type) your (?:social security|ssn|date of birth|full name|address|phone|email)/i,
  // The AI should never discuss its own instructions or training
  /(?:my|the) (?:instructions|training|system prompt|programming|guidelines) (?:say|tell|indicate|require)/i,
  // The AI should never reference being an AI in a way that breaks the kiosk experience
  /(?:as an ai|as a language model|i am (?:an? )?(?:ai|llm|language model|chatbot))/i,
];

// ── Validation functions ────────────────────────────────────────────

/**
 * Validate extracted CUSHION_DATA fields against the current intake section.
 * Returns which fields are expected, unexpected, and whether any are blocked.
 *
 * @param {string} section - Current section: WELCOME, HOUSEHOLD, INCOME, EXPENSES, REVIEW
 * @param {Array<{field: string}>} extractedData - Data blocks from the AI response
 * @returns {{ valid: boolean, expectedFields: string[], unexpectedFields: string[], blockedFields: string[] }}
 */
function validateFieldsForSection(section, extractedData) {
  const ctx = SECTION_CONTEXT[section];
  if (!ctx || !extractedData || extractedData.length === 0) {
    return { valid: true, expectedFields: [], unexpectedFields: [], blockedFields: [] };
  }

  const allowed = new Set([...ctx.expectedFields, ...(ctx.adjacentFields || [])]);
  const expectedFields = [];
  const unexpectedFields = [];

  for (const block of extractedData) {
    const field = block.field;
    if (!field) continue;

    if (allowed.has(field)) {
      expectedFields.push(field);
    } else {
      unexpectedFields.push(field);
    }
  }

  return {
    valid: unexpectedFields.length === 0,
    expectedFields,
    unexpectedFields,
    blockedFields: [], // Reserved for future hard-block fields
  };
}

/**
 * Score the AI response's relevance to the current intake section.
 * Uses section-specific keywords rather than generic SNAP vocabulary.
 *
 * Short responses (greetings, confirmations) are exempt — the AI often
 * says "Got it!" or "Thank you!" without section-specific vocabulary.
 *
 * @param {string} section - Current intake section
 * @param {string} aiResponse - The AI's display message (no data blocks)
 * @returns {{ relevant: boolean, score: number, section: string, reason?: string }}
 */
const SECTION_CHECK_MIN_LENGTH = 80;
const SECTION_SCORE_THRESHOLD = 0.02;

function scoreSectionRelevance(section, aiResponse) {
  if (typeof aiResponse !== "string" || aiResponse.length < SECTION_CHECK_MIN_LENGTH) {
    return { relevant: true, score: 1.0, section };
  }

  const ctx = SECTION_CONTEXT[section];
  if (!ctx) {
    return { relevant: true, score: 1.0, section };
  }

  const lower = aiResponse.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return { relevant: true, score: 1.0, section };

  let matches = 0;
  for (const keyword of ctx.keywords) {
    if (lower.includes(keyword)) matches++;
  }

  const score = matches / words.length;

  // A response is relevant if it has enough section-specific keywords
  // OR if it has at least 3 keyword matches (some responses are short but on-topic)
  if (score >= SECTION_SCORE_THRESHOLD || matches >= 3) {
    return { relevant: true, score, section };
  }

  return {
    relevant: false,
    score,
    section,
    reason: `Low section relevance for ${section} (score: ${score.toFixed(4)}, matches: ${matches}/${ctx.keywords.length})`,
  };
}

/**
 * Check the AI response for forbidden content patterns — things the AI
 * should never say regardless of which section we're in.
 *
 * @param {string} aiResponse - The AI's display message
 * @returns {{ clean: boolean, violations: string[] }}
 */
function checkForbiddenContent(aiResponse) {
  if (typeof aiResponse !== "string") return { clean: true, violations: [] };

  const violations = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(aiResponse)) {
      violations.push(pattern.source);
    }
  }

  return { clean: violations.length === 0, violations };
}

/**
 * Full context validation: combines field validation, section relevance,
 * and forbidden content checks into a single result.
 *
 * @param {string} section - Current intake section
 * @param {string} aiResponse - The AI's display message
 * @param {Array<{field: string}>} extractedData - Parsed CUSHION_DATA blocks
 * @returns {{ ok: boolean, fieldCheck: object, relevanceCheck: object, forbiddenCheck: object }}
 */
function validateConversationContext(section, aiResponse, extractedData) {
  const fieldCheck = validateFieldsForSection(section, extractedData);
  const relevanceCheck = scoreSectionRelevance(section, aiResponse);
  const forbiddenCheck = checkForbiddenContent(aiResponse);

  return {
    ok: fieldCheck.valid && relevanceCheck.relevant && forbiddenCheck.clean,
    fieldCheck,
    relevanceCheck,
    forbiddenCheck,
  };
}

module.exports = {
  SECTION_CONTEXT,
  FORBIDDEN_PATTERNS,
  validateFieldsForSection,
  scoreSectionRelevance,
  checkForbiddenContent,
  validateConversationContext,
  SECTION_CHECK_MIN_LENGTH,
  SECTION_SCORE_THRESHOLD,
};
