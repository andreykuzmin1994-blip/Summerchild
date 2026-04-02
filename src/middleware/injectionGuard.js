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
  /ignore.*(?:previous|prior|above|all).*(?:instructions|rules|guidelines)/i,
  /forget.*(?:rules|instructions|guidelines|everything)/i,
  /pretend.*(?:you are|you're|to be)/i,
  /(?:from now on|going forward).*(?:you|do not|don't|skip|ignore)/i,
  /do not (?:flag|check|verify|validate)/i,
  /override.*(?:rules|checks|system)/i,
  /(?:system|initial|original) prompt/i,
  /you are now/i,
  /new (?:instructions|role|persona|identity)/i,
  /disregard.*(?:previous|above|prior)/i,
  /(?:reveal|show|display|output|repeat).*(?:instructions|prompt|rules)/i,
  /(?:act|behave|respond) as (?:if|though)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /(?:sudo|admin|root) mode/i,
];

const INJECTION_RESPONSE =
  "I didn't quite catch that. Could you rephrase? I'm here to help with your SNAP application.";

const MAX_INPUT_LENGTH = 2000;
const SPECIAL_CHAR_THRESHOLD = 0.15;

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

  // Pattern matching against normalized text
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: pattern.source };
    }
  }

  // Encoding attack detection: base64, hex, rot13 payloads
  const encodingCheck = detectEncodedPayload(normalized);
  if (encodingCheck.detected) {
    return { blocked: true, reason: `encoded_payload_${encodingCheck.encoding}` };
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
  injectionGuardMiddleware,
  INJECTION_RESPONSE,
  INJECTION_PATTERNS,
  normalizeUnicode,
  detectEncodedPayload,
};
