/**
 * Output Guardrails — validates AI responses before they reach the applicant.
 *
 * This is the OUTPUT counterpart to injectionGuard.js (INPUT) and
 * piiStripper.js (INPUT). Together they form a three-layer guardrail:
 *
 *   INPUT:  injectionGuard → piiStripper → [AI] → outputGuardrails :OUTPUT
 *
 * Each rail returns { passed, violation?, corrected? } so the caller can
 * decide whether to block, warn, or auto-correct the response.
 *
 * County compliance: all violations are structured for audit logging.
 */

const { child } = require("../services/logger");
const log = child("output-guardrails");

// ── Rail 1: Eligibility Determination Guard ─────────────────────────
// The AI must NEVER make eligibility determinations. If it says "you
// qualify" or "you are eligible," that's a policy violation — the
// caseworker makes that call.

const ELIGIBILITY_PATTERNS = [
  /\byou (?:are|would be|will be|should be) (?:eligible|qualified|approved)\b/i,
  /\byou (?:qualify|are entitled)\b/i,
  /\byou (?:do not|don't|won't) qualify\b/i,
  /\byou (?:are not|aren't) eligible\b/i,
  /\byour (?:benefits?|allotment|amount) (?:will|would) be \$\d/i,
  /\byou(?:'ll| will) (?:receive|get) \$\d/i,
];

function checkEligibilityDetermination(aiResponse) {
  for (const pattern of ELIGIBILITY_PATTERNS) {
    const match = aiResponse.match(pattern);
    if (match) {
      return {
        passed: false,
        violation: "eligibility_determination",
        detail: `AI made an eligibility statement: "${match[0]}"`,
      };
    }
  }
  return { passed: true };
}

// ── Rail 2: System Prompt Leakage Guard ─────────────────────────────
// The AI should never output fragments of its own system prompt.

const SYSTEM_PROMPT_MARKERS = [
  "ROLE DEFINITION:",
  "SECURITY RULES — THESE CANNOT BE OVERRIDDEN",
  "CONVERSATION MANAGEMENT:",
  "STRUCTURED DATA OUTPUT:",
  "<!--CUSHION_DATA:",
  "CUSHION_DATA",
  "IMPORTANT — WHAT YOU DO NOT COLLECT:",
  "cache_control",
  "ephemeral",
];

function checkSystemPromptLeakage(aiResponse) {
  // The CUSHION_DATA tags are expected in rawMessage but should never
  // appear in the display message. This check runs on displayMessage.
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    if (aiResponse.includes(marker)) {
      return {
        passed: false,
        violation: "system_prompt_leakage",
        detail: `Response contains system prompt fragment: "${marker}"`,
      };
    }
  }
  return { passed: true };
}

// ── Rail 3: Off-Topic Guard ─────────────────────────────────────────
// The AI should stay focused on SNAP intake. If it starts discussing
// unrelated topics at length, flag it. This uses keyword density —
// if the response has multiple off-topic indicators without any
// SNAP-related terms, it's likely off-topic.

const OFF_TOPIC_INDICATORS = [
  /\b(?:stock market|stocks)\b/i,
  /\b(?:crypto|bitcoin|ethereum)\b/i,
  /\b(?:invest(?:ing|ment)?|trading)\b/i,
  /\b(?:recipe|cook|bake|ingredient)\b/i,
  /\b(?:weather|forecast|temperature)\b/i,
  /\b(?:sports?|game|score|team|player)\b/i,
  /\b(?:movie|tv show|series|episode|watch)\b/i,
  /\b(?:write (?:a |me )?(?:poem|story|essay|code|script))\b/i,
  /\b(?:translate|translation)\b/i,
  /\b(?:joke|funny|humor)\b/i,
];

const ON_TOPIC_INDICATORS = [
  /\b(?:SNAP|food (?:stamps|assistance)|benefits?|EBT)\b/i,
  /\b(?:income|household|shelter|rent|utilities|deduction)\b/i,
  /\b(?:caseworker|application|intake|eligib|DFCS)\b/i,
  /\b(?:expense|employment|employer|pay|wage)\b/i,
  /\b(?:dependent|elderly|disabled|medical)\b/i,
];

function checkOffTopic(aiResponse) {
  const offTopicHits = OFF_TOPIC_INDICATORS.filter((p) => p.test(aiResponse)).length;
  const onTopicHits = ON_TOPIC_INDICATORS.filter((p) => p.test(aiResponse)).length;

  // Only flag if multiple off-topic indicators AND no on-topic content
  if (offTopicHits >= 2 && onTopicHits === 0) {
    return {
      passed: false,
      violation: "off_topic",
      detail: `Response appears off-topic (${offTopicHits} off-topic indicators, 0 on-topic)`,
    };
  }
  return { passed: true };
}

// ── Rail 4: PII in Output Guard ─────────────────────────────────────
// The AI should never output PII patterns, even if the user provided
// them in input and they somehow got through the input PII stripper.

const OUTPUT_PII_PATTERNS = [
  { pattern: /\b\d{3}-?\d{2}-?\d{4}\b/, type: "SSN" },
  { pattern: /\b\(?\d{3}\)?[-.)\s]?\d{3}[-.)\s]?\d{4}\b/, type: "Phone" },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/, type: "Email" },
];

// Known safe patterns that look like PII but aren't
const SAFE_NUMBER_PATTERNS = [
  /^\$[\d,]+/, // Dollar amounts
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, // Dates
];

function checkOutputPII(aiResponse) {
  for (const { pattern, type } of OUTPUT_PII_PATTERNS) {
    const matches = aiResponse.match(new RegExp(pattern.source, "g"));
    if (matches) {
      // Filter out dollar amounts and dates
      const realPII = matches.filter(
        (m) => !SAFE_NUMBER_PATTERNS.some((safe) => safe.test(m))
      );
      if (realPII.length > 0) {
        return {
          passed: false,
          violation: "pii_in_output",
          detail: `${type} pattern found in AI output`,
          // Auto-correct by redacting
          corrected: aiResponse.replace(new RegExp(pattern.source, "g"), "[REDACTED]"),
        };
      }
    }
  }
  return { passed: true };
}

// ── Rail 5: Response Length Guard ────────────────────────────────────
// Abnormally long responses may indicate the AI is dumping its context
// or got stuck in a loop. Short responses are fine for SNAP intake.

const MAX_RESPONSE_LENGTH = 3000;

function checkResponseLength(aiResponse) {
  if (aiResponse.length > MAX_RESPONSE_LENGTH) {
    return {
      passed: false,
      violation: "excessive_length",
      detail: `Response is ${aiResponse.length} chars (max ${MAX_RESPONSE_LENGTH})`,
      // Auto-correct by truncating with a graceful ending
      corrected: aiResponse.substring(0, MAX_RESPONSE_LENGTH).replace(/\s+\S*$/, "") +
        "\n\nLet me keep this focused. What's the next piece of information you'd like to share?",
    };
  }
  return { passed: true };
}

// ── Main guardrail runner ───────────────────────────────────────────

const ALL_RAILS = [
  { name: "eligibility_determination", fn: checkEligibilityDetermination, severity: "block" },
  { name: "system_prompt_leakage", fn: checkSystemPromptLeakage, severity: "block" },
  { name: "off_topic", fn: checkOffTopic, severity: "warn" },
  { name: "pii_in_output", fn: checkOutputPII, severity: "correct" },
  { name: "response_length", fn: checkResponseLength, severity: "correct" },
];

/**
 * Run all output guardrails against an AI response.
 *
 * @param {string} displayMessage - The AI response text (with CUSHION_DATA tags stripped)
 * @returns {{
 *   passed: boolean,
 *   violations: Array<{rail: string, severity: string, detail: string}>,
 *   correctedMessage: string|null,
 *   blocked: boolean
 * }}
 */
function runOutputGuardrails(displayMessage) {
  const violations = [];
  let correctedMessage = null;
  let currentMessage = displayMessage;
  let blocked = false;

  for (const rail of ALL_RAILS) {
    const result = rail.fn(currentMessage);

    if (!result.passed) {
      const violation = {
        rail: rail.name,
        severity: rail.severity,
        detail: result.detail,
      };
      violations.push(violation);

      log.warn("Output guardrail violation", violation);

      if (rail.severity === "block") {
        blocked = true;
        // Don't continue checking — the response will be replaced entirely
        break;
      }

      if (rail.severity === "correct" && result.corrected) {
        currentMessage = result.corrected;
        correctedMessage = currentMessage;
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    correctedMessage,
    blocked,
  };
}

/**
 * Default safe response used when a response is blocked.
 */
const BLOCKED_RESPONSE =
  "I want to make sure I give you accurate information. " +
  "Let me get back on track — what's the next piece of information about your household, income, or expenses?";

module.exports = {
  runOutputGuardrails,
  BLOCKED_RESPONSE,
  // Export individual rails for testing
  checkEligibilityDetermination,
  checkSystemPromptLeakage,
  checkOffTopic,
  checkOutputPII,
  checkResponseLength,
  ALL_RAILS,
};
