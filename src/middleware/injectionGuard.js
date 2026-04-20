/**
 * Prompt Injection Detection — Layer 1 defense.
 * Scans user input for injection patterns before it reaches Claude.
 *
 * Techniques (aligned with OWASP LLM Top 10 2025 and Anthropic research):
 * 1. Regex pattern matching for known injection phrases
 * 2. Length and special character density heuristics
 * 3. Unicode normalization to defeat homoglyph/confusable bypasses
 * 4. Encoding attack detection (base64, hex, rot13 payloads)
 * 5. Invisible character stripping (zero-width spaces, RTL marks)
 */

/**
 * Normalize Unicode text to defeat homoglyph attacks.
 * Attackers use visually similar characters (e.g., Cyrillic "а" for Latin "a")
 * to bypass regex-based injection detection.
 * NFKC normalization maps these to their canonical ASCII equivalents.
 */
function normalizeUnicode(text) {
  // NFKC: Compatibility Decomposition, followed by Canonical Composition
  // This maps fullwidth, halfwidth, and confusable characters to ASCII equivalents
  let normalized = text.normalize("NFKC");

  // Strip zero-width and invisible characters used to split injection keywords
  normalized = normalized.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u034F\u2060\u2061\u2062\u2063\u2064\u206A-\u206F]/g, "");

  return normalized;
}

/**
 * Detect encoded payloads that may contain injection attempts.
 * Attackers encode injection phrases in base64, hex, or rot13 to
 * bypass pattern-matching filters.
 * Returns { detected: boolean, encoding?: string }
 */
function detectEncodedPayload(text) {
  // Base64 detection: look for long base64-encoded strings
  const base64Pattern = /[A-Za-z0-9+/]{40,}={0,2}/;
  const base64Match = text.match(base64Pattern);
  if (base64Match) {
    try {
      const decoded = Buffer.from(base64Match[0], "base64").toString("utf-8");
      // Check if decoded content contains readable injection phrases
      if (/[a-z ]{10,}/i.test(decoded) && /(?:ignore|system|prompt|instruction|role|pretend)/i.test(decoded)) {
        return { detected: true, encoding: "base64" };
      }
    } catch {
      // Not valid base64 — ignore
    }
  }

  // Hex-encoded strings: \x69\x67\x6e\x6f\x72\x65 or 0x69676e6f7265
  const hexPattern = /(?:\\x[0-9a-f]{2}){8,}/i;
  if (hexPattern.test(text)) {
    return { detected: true, encoding: "hex_escape" };
  }

  // Rot13 heuristic: look for "vtaber" (rot13 of "ignore"), "flfgrz" (rot13 of "system")
  const rot13Keywords = ["vtaber", "flfgrz", "cebzcg", "vafgehpgvba", "wnvyoernx"];
  const lower = text.toLowerCase();
  for (const keyword of rot13Keywords) {
    if (lower.includes(keyword)) {
      return { detected: true, encoding: "rot13" };
    }
  }

  return { detected: false };
}

const INJECTION_PATTERNS = [
  // Multi-word patterns: require the full injection phrase structure.
  // These are written to avoid matching natural speech from ESL applicants.
  // e.g., "pretend to be strong" should NOT match; "pretend to be a different AI" SHOULD.
  /ignore.*(?:previous|prior|above|all).*(?:instructions|rules|guidelines)/i,
  /forget.*(?:rules|instructions|guidelines|everything you)/i,
  /pretend.*(?:you are|you're|to be) (?:a different|another|an? ai|an? assistant|an? chatbot|someone|something)/i,
  /(?:from now on|going forward).*(?:you (?:will|should|must|are)|do not|don't|skip|ignore)/i,
  /do not (?:flag|check|verify|validate) (?:any|my|the|this)/i,
  /override.*(?:rules|checks|system|safety|security)/i,
  /(?:system|initial|original) prompt/i,
  /you are now (?:a |an |my |in |free|unfiltered|unrestricted|jailbroken)/i,
  /new (?:instructions|persona|identity|directive)/i,
  /disregard.*(?:previous|above|prior).*(?:instructions|rules|guidelines)/i,
  /(?:reveal|show|display|output|repeat).*(?:instructions|system prompt|rules|hidden)/i,
  /(?:act|behave|respond) as (?:if you were|though you were|if you are)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /(?:sudo|admin|root) mode/i,
];

// Structural injection patterns — XML-like, bracket enclosure, delimiter injection
const STRUCTURAL_PATTERNS = [
  /\[(?:SYSTEM|RULES|INSTRUCTIONS|PROMPT|ADMIN|OVERRIDE)\]/i,
  /(?:---+|===+)\s*(?:SYSTEM|RULES|PROMPT|INSTRUCTIONS)/i,
  /\b(?:instructions|rules|prompt|system):\s*[{\[\n]/i,
  /```(?:system|prompt|instructions|rules)/i,
  /<\/?(?:system|prompt|instructions|rules)>/i,
];

const INJECTION_RESPONSE =
  "I didn't quite catch that. Could you rephrase? I'm here to help with your SNAP application.";

const MAX_INPUT_LENGTH = 2000;
const SPECIAL_CHAR_THRESHOLD = 0.25;

/**
 * Check user input for prompt injection attempts.
 * Returns { blocked: boolean, reason?: string }
 */
function checkForInjection(userInput) {
  const raw = (userInput || "").trim();

  // Length-based heuristic (check raw input first, before normalization)
  if (raw.length > MAX_INPUT_LENGTH) {
    return { blocked: true, reason: "excessive_length" };
  }

  // Unicode normalization: defeats homoglyph and invisible-character bypasses
  const normalized = normalizeUnicode(raw);

  // Encoded payload detection (base64, hex, rot13) — check both raw and
  // normalized. Normalization can strip characters that would split an
  // encoded blob into smaller fragments below detection thresholds.
  const encodedCheckRaw = detectEncodedPayload(raw);
  if (encodedCheckRaw.detected) {
    return { blocked: true, reason: `encoded_payload: ${encodedCheckRaw.encoding}` };
  }
  const encodedCheck = detectEncodedPayload(normalized);
  if (encodedCheck.detected) {
    return { blocked: true, reason: `encoded_payload: ${encodedCheck.encoding}` };
  }

  // Pattern matching — run against BOTH the raw input and the normalized
  // form. Some attacks embed invisible chars so the raw text doesn't match
  // regex; others use homoglyphs that only the normalized form exposes.
  // Checking both closes the gap (defense-in-depth).
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      return { blocked: true, reason: pattern.source };
    }
  }

  // Structural pattern matching — same raw+normalized strategy
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      return { blocked: true, reason: `structural_injection: ${pattern.source}` };
    }
  }

  // Length-based heuristic
  if (normalized.length > MAX_INPUT_LENGTH) {
    return { blocked: true, reason: "excessive_length" };
  }

  // High ratio of special characters or code-like syntax
  const specialChars = (normalized.match(/[{}\[\]<>\/\\|`~^]/g) || []).length;
  if (normalized.length > 0 && specialChars / normalized.length > SPECIAL_CHAR_THRESHOLD) {
    return { blocked: true, reason: "suspicious_formatting" };
  }

  return { blocked: false };
}

/**
 * Express middleware that checks incoming messages for injection.
 */
function injectionGuardMiddleware(req, res, next) {
  const userMessage = req.body?.message;
  if (!userMessage) return next();

  const result = checkForInjection(userMessage);
  if (result.blocked) {
    // Log the attempt for security review
    console.warn(`[INJECTION BLOCKED] Reason: ${result.reason}, Input length: ${userMessage.length}`);

    // Persist to audit trail for CJIS compliance — async, non-blocking
    try {
      const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
      const sessionToken = req.body?.sessionToken;
      logAuditEvent({
        type: EVENTS.INJECTION_BLOCKED,
        actorType: ACTORS.APPLICANT,
        actorId: sessionToken || "unknown",
        ip: req.ip,
        details: {
          reason: result.reason,
          inputLength: userMessage.length,
          // Store a truncated, sanitized snippet for forensic review — never the full input
          snippet: userMessage.slice(0, 100).replace(/[^\x20-\x7E]/g, ""),
        },
      }).catch(() => {});
    } catch {
      // Audit logging failure must not block the response
    }

    return res.json({
      message: INJECTION_RESPONSE,
      blocked: true,
    });
  }

  next();
}

module.exports = {
  checkForInjection,
  detectEncodedPayload,
  normalizeUnicode,
  injectionGuardMiddleware,
  INJECTION_RESPONSE,
  INJECTION_PATTERNS,
  STRUCTURAL_PATTERNS,
};
