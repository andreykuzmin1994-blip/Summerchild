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
  const normalized = (userInput || "").trim();

  // Pattern matching
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: pattern.source };
    }
  }

  // Structural pattern matching
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(normalized)) {
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
    return res.json({
      message: INJECTION_RESPONSE,
      blocked: true,
      injectionDetected: true,
    });
  }

  next();
}

module.exports = {
  checkForInjection,
  injectionGuardMiddleware,
  INJECTION_RESPONSE,
  INJECTION_PATTERNS,
  STRUCTURAL_PATTERNS,
};
