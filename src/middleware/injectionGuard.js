/**
 * Prompt Injection Detection — Layer 1 defense.
 * Scans user input for injection patterns before it reaches Claude.
 */

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
  const normalized = (userInput || "").trim();

  // Pattern matching
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: pattern.source };
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
  injectionGuardMiddleware,
  INJECTION_RESPONSE,
  INJECTION_PATTERNS,
};
