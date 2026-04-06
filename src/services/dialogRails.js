/**
 * Dialog Rails Engine — Colang-inspired declarative conversation flow control.
 *
 * Implements NeMo Guardrails concepts in JavaScript:
 *
 *   - **Dialog rails**: Define the expected conversation flow as a sequence
 *     of sections, each with required data fields and transition rules.
 *   - **Input rails**: Check user messages against the current flow state
 *     and reject/redirect off-flow input.
 *   - **Output rails**: Validate that bot responses match the expected
 *     section and contain appropriate data extraction attempts.
 *   - **Retrieval rails**: Validate that context (system prompt data)
 *     pulled from the database is current and complete before it
 *     reaches the LLM.
 *
 * This is a JavaScript port of the Colang pattern — no Python dependency.
 * For full NeMo Guardrails, see nemo-sidecar/ for Docker deployment.
 *
 * Usage:
 *   const engine = new DialogRailEngine();
 *   engine.transition("HOUSEHOLD");
 *   const check = engine.checkInputRail(userMessage);
 *   const outputCheck = engine.checkOutputRail(aiResponse, extractedData);
 */

const { child } = require("./logger");
const log = child("dialog-rails");

// ── Section definitions (the "Colang flows") ────────────────────────
// Each section defines:
//   - expectedFields: data the AI should be extracting in this section
//   - requiredBefore: minimum fields needed before transitioning OUT
//   - inputPatterns: user message patterns that belong in this section
//   - redirectMessage: what to say if the user jumps ahead
//   - maxTurns: safety limit to prevent stuck sections

const SECTIONS = {
  WELCOME: {
    order: 0,
    expectedFields: ["applicant_info", "applicant_language"],
    requiredBefore: [],
    inputPatterns: [
      /\b(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/i,
      /\b(?:name is|i'm|i am)\b/i,
      /\b(?:snap|benefits?|food (?:stamps|assistance)|apply|application)\b/i,
    ],
    maxTurns: 3,
  },

  HOUSEHOLD: {
    order: 1,
    expectedFields: ["household_member"],
    requiredBefore: [],
    inputPatterns: [
      /\b(?:live|household|family|member|spouse|child|children|kid|parent|people)\b/i,
      /\b(?:elderly|disabled|age|old|young)\b/i,
      /\b(?:together|alone|roommate|separate)\b/i,
      /\b(?:cook|prepare|purchase|food|eat|meals?)\b/i,
    ],
    redirectMessage: "Before we discuss that, let me finish collecting your household information. ",
    maxTurns: 10,
  },

  INCOME: {
    order: 2,
    expectedFields: ["income_source"],
    requiredBefore: ["household_member"],
    inputPatterns: [
      /\b(?:income|earn|salary|wage|pay|paid|job|work|employ|boss)\b/i,
      /\b(?:self[- ]employ|business|freelance|gig|side)\b/i,
      /\b(?:ssi|ssdi|social security|unemployment|pension|va |veterans?)\b/i,
      /\b(?:child support|alimony|disability)\b/i,
      /\b(?:weekly|biweekly|monthly|per (?:week|month|hour))\b/i,
      /\b\$\d/,
    ],
    redirectMessage: "We'll get to income next. First, let me make sure I have everyone in your household. ",
    maxTurns: 15,
  },

  EXPENSES: {
    order: 3,
    expectedFields: [
      "shelter_rent", "shelter_expense", "shelter_utility",
      "dependent_care", "medical_expenses", "child_support_paid",
    ],
    requiredBefore: ["income_source"],
    inputPatterns: [
      /\b(?:rent|mortgage|shelter|housing|apartment|house)\b/i,
      /\b(?:utilit|electric|gas|heat|water|phone|internet)\b/i,
      /\b(?:daycare|child ?care|dependent care|babysit)\b/i,
      /\b(?:medical|doctor|prescri|health|insurance)\b/i,
      /\b(?:property tax|homeowner|renter)\b/i,
    ],
    redirectMessage: "We'll cover your expenses shortly. Let me first finish with your income. ",
    maxTurns: 12,
  },

  REVIEW: {
    order: 4,
    expectedFields: [],
    requiredBefore: [],
    inputPatterns: [
      /\b(?:correct|yes|no|change|fix|wrong|right|confirm|done|submit)\b/i,
      /\b(?:look(?:s)? (?:good|right|correct))\b/i,
      /\b(?:that'?s (?:right|correct|it|all|everything))\b/i,
    ],
    maxTurns: 5,
  },
};

// ── Retrieval rail checks ───────────────────────────────────────────
// Validate that database-sourced context is complete before it enters
// the system prompt. This prevents stale/missing policy data from
// causing incorrect AI responses.

const REQUIRED_CONTEXT_FIELDS = [
  { path: "snapConfig", description: "State SNAP configuration (BBCE, income limits)" },
  { path: "federalData", description: "Federal SNAP data (income limits, allotments)" },
];

/**
 * Validate retrieval context before it enters the system prompt.
 * Returns { passed, missing[] }
 */
function checkRetrievalRail(context) {
  const missing = [];

  for (const { path, description } of REQUIRED_CONTEXT_FIELDS) {
    const value = context[path];
    if (!value || (Array.isArray(value) && value.length === 0)) {
      missing.push({ field: path, description });
    }
  }

  // Check federal data completeness (should have HH sizes 1-8 minimum)
  if (context.federalData && Array.isArray(context.federalData)) {
    const sizes = context.federalData.map((d) => d.householdSize);
    for (let i = 1; i <= 8; i++) {
      if (!sizes.includes(i)) {
        missing.push({
          field: `federalData[HH${i}]`,
          description: `Missing federal data for household size ${i}`,
        });
      }
    }
  }

  if (missing.length > 0) {
    log.error("Retrieval rail: missing context data", { missing });
  }

  return {
    passed: missing.length === 0,
    missing,
  };
}

// ── Dialog Rail Engine ──────────────────────────────────────────────

class DialogRailEngine {
  constructor() {
    this.currentSection = "WELCOME";
    this.collectedFields = new Map(); // field → count of instances
    this.turnInSection = 0;
    this.sectionHistory = ["WELCOME"];
  }

  /**
   * Get the current section configuration.
   */
  getCurrentConfig() {
    return SECTIONS[this.currentSection];
  }

  /**
   * Transition to a new section.
   * Returns { allowed, reason? }
   */
  transition(targetSection) {
    const target = SECTIONS[targetSection];
    const current = SECTIONS[this.currentSection];

    if (!target) {
      return { allowed: false, reason: `Unknown section: ${targetSection}` };
    }

    // Can't go backwards (except REVIEW → any for corrections)
    if (target.order < current.order && this.currentSection !== "REVIEW") {
      return {
        allowed: false,
        reason: `Cannot go back from ${this.currentSection} to ${targetSection}`,
      };
    }

    // Check required fields before leaving current section
    const requiredForNext = target.requiredBefore || [];
    const missingRequired = requiredForNext.filter(
      (field) => !this.collectedFields.has(field)
    );

    if (missingRequired.length > 0) {
      return {
        allowed: false,
        reason: `Missing required fields before ${targetSection}: ${missingRequired.join(", ")}`,
        missingFields: missingRequired,
      };
    }

    log.info("Section transition", {
      from: this.currentSection,
      to: targetSection,
      turnsInPrevious: this.turnInSection,
    });

    this.currentSection = targetSection;
    this.turnInSection = 0;
    this.sectionHistory.push(targetSection);
    return { allowed: true };
  }

  /**
   * INPUT RAIL: Check if a user message fits the current section.
   *
   * Returns:
   *   { allowed: true } — message fits current flow
   *   { allowed: true, suggestTransition: "INCOME" } — message fits a later section, auto-transition
   *   { allowed: false, redirectMessage: "..." } — message is premature, redirect
   */
  checkInputRail(userMessage) {
    this.turnInSection++;

    // Always allow in WELCOME (first messages are unpredictable)
    if (this.currentSection === "WELCOME") {
      return { allowed: true };
    }

    // Always allow in REVIEW (user can say anything to confirm/correct)
    if (this.currentSection === "REVIEW") {
      return { allowed: true };
    }

    // Check if message matches current section
    const currentConfig = SECTIONS[this.currentSection];
    const matchesCurrent = currentConfig.inputPatterns.some((p) => p.test(userMessage));

    if (matchesCurrent) {
      return { allowed: true };
    }

    // Check if message matches a LATER section (user jumping ahead)
    const currentOrder = currentConfig.order;
    for (const [sectionName, config] of Object.entries(SECTIONS)) {
      if (config.order > currentOrder) {
        const matchesLater = config.inputPatterns.some((p) => p.test(userMessage));
        if (matchesLater) {
          // Check if we have enough data to auto-transition
          const transition = this.transition(sectionName);
          if (transition.allowed) {
            return { allowed: true, suggestTransition: sectionName };
          }
          // Can't transition yet — redirect
          return {
            allowed: false,
            redirectMessage: currentConfig.redirectMessage || "",
            attemptedSection: sectionName,
          };
        }
      }
    }

    // Message doesn't match any section pattern — allow it through
    // (could be a clarification, question, or data we didn't pattern-match)
    return { allowed: true };
  }

  /**
   * OUTPUT RAIL: Check if the AI response is appropriate for the current section.
   *
   * Validates:
   *   1. Extracted data fields match the expected section
   *   2. The AI isn't skipping sections
   *   3. Max turns haven't been exceeded (stuck detection)
   */
  checkOutputRail(extractedData) {
    const config = SECTIONS[this.currentSection];
    const violations = [];

    // Check if extracted fields match expected section
    for (const block of extractedData) {
      if (!block.field) continue;

      // Record that we've collected this field type
      const count = this.collectedFields.get(block.field) || 0;
      this.collectedFields.set(block.field, count + 1);

      // Check if this field belongs to a later section
      for (const [sectionName, sConfig] of Object.entries(SECTIONS)) {
        if (sConfig.order > config.order && sConfig.expectedFields.includes(block.field)) {
          violations.push({
            type: "premature_extraction",
            detail: `Extracted ${block.field} (belongs to ${sectionName}) while in ${this.currentSection}`,
          });
        }
      }
    }

    // Check if we're stuck (too many turns in one section)
    if (config.maxTurns && this.turnInSection > config.maxTurns) {
      violations.push({
        type: "section_stuck",
        detail: `${this.turnInSection} turns in ${this.currentSection} (max ${config.maxTurns})`,
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      currentSection: this.currentSection,
      turnsInSection: this.turnInSection,
      collectedFields: Object.fromEntries(this.collectedFields),
    };
  }

  /**
   * Auto-detect section transitions based on collected data.
   * Call this after processing extractedData to see if we should advance.
   */
  suggestNextSection() {
    const config = SECTIONS[this.currentSection];

    // If we've collected enough data for the next section, suggest transition
    const sectionNames = Object.keys(SECTIONS);
    const currentIndex = sectionNames.indexOf(this.currentSection);
    const nextSection = sectionNames[currentIndex + 1];

    if (!nextSection) return null; // Already at REVIEW

    // Check if we have at least one instance of each expected field
    const hasExpectedData = config.expectedFields.length === 0 ||
      config.expectedFields.some((f) => this.collectedFields.has(f));

    // For WELCOME, auto-advance after any data or 2+ turns
    if (this.currentSection === "WELCOME" && (hasExpectedData || this.turnInSection >= 2)) {
      return nextSection;
    }

    return null;
  }

  /**
   * Get current state for debugging/logging.
   */
  getState() {
    return {
      currentSection: this.currentSection,
      turnInSection: this.turnInSection,
      sectionHistory: this.sectionHistory,
      collectedFields: Object.fromEntries(this.collectedFields),
    };
  }

  /**
   * Serialize for session storage.
   */
  serialize() {
    return {
      currentSection: this.currentSection,
      collectedFields: Array.from(this.collectedFields.entries()),
      turnInSection: this.turnInSection,
      sectionHistory: this.sectionHistory,
    };
  }

  /**
   * Restore from serialized state.
   */
  static deserialize(data) {
    const engine = new DialogRailEngine();
    if (data) {
      engine.currentSection = data.currentSection || "WELCOME";
      engine.collectedFields = new Map(data.collectedFields || []);
      engine.turnInSection = data.turnInSection || 0;
      engine.sectionHistory = data.sectionHistory || ["WELCOME"];
    }
    return engine;
  }
}

module.exports = {
  DialogRailEngine,
  checkRetrievalRail,
  SECTIONS,
  REQUIRED_CONTEXT_FIELDS,
};
