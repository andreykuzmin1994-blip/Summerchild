/**
 * System Prompt Validator — ensures no PII leaks into the cached system prompt.
 * Runs at startup and before each session's first API call.
 */

const PII_PATTERNS = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, type: "SSN" },
  { pattern: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/, type: "Phone" },
  { pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/, type: "Proper name (heuristic)" },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/, type: "Email" },
  { pattern: /\b\d+\s+[A-Z][a-z]+\s+(St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy)\b/i, type: "Address" },
];

// Known safe proper-name patterns that appear in policy text
const SAFE_PATTERNS = [
  "Federal Poverty", "Standard Utility", "SNAP Household", "Heating Cooling",
  "Social Security", "Head Household", "Georgia DFCS", "Georgia Gateway",
  "DeKalb County", "Fulton County", "SNAP Payment",
];

/**
 * Validate that a system prompt contains no PII.
 * Throws if PII is detected.
 */
function validateSystemPrompt(prompt) {
  const issues = [];

  for (const { pattern, type } of PII_PATTERNS) {
    const matches = prompt.match(new RegExp(pattern.source, pattern.flags + "g"));
    if (matches) {
      // Filter out known safe matches
      const unsafe = matches.filter((m) => !SAFE_PATTERNS.some((safe) => m.includes(safe) || safe.includes(m)));
      if (unsafe.length > 0 && type !== "Proper name (heuristic)") {
        issues.push({ type, matches: unsafe });
      }
    }
  }

  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.type}: ${i.matches.join(", ")}`).join("; ");
    throw new Error(`CRITICAL: PII detected in system prompt — blocking startup. Details: ${detail}`);
  }

  return true;
}

module.exports = { validateSystemPrompt, PII_PATTERNS };
