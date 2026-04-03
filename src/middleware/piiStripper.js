/**
 * PII Safety Layer — lightweight guard that catches any PII an applicant
 * might accidentally type (e.g., full SSN, phone number) and redacts it
 * before sending to the Claude API.
 *
 * Since we only collect first name + last initial, this is a safety net,
 * not the primary PII strategy. The primary strategy is: don't ask for PII.
 */
class PIIStripper {
  constructor() {
    this.mappings = new Map();
  }

  /**
   * Strip any accidentally-provided PII from text before sending to AI.
   */
  strip(text) {
    let cleaned = text;

    // Replace mapped names with role labels
    for (const [realName, placeholder] of this.mappings) {
      cleaned = cleaned.replaceAll(realName, placeholder);
    }

    // Replace SSN patterns — catches all formats: 123-45-6789, 123 45 6789, 123456789
    cleaned = cleaned.replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, "[REDACTED]");
    cleaned = cleaned.replace(/\b\d{9}\b/g, "[REDACTED]");

    // Replace phone patterns — catches (404) 555-0123, 404.555.0123, +1-404-555-0123, ext
    cleaned = cleaned.replace(
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d+)?/gi,
      "[REDACTED]"
    );

    // Replace street addresses — expanded suffix list
    cleaned = cleaned.replace(
      /\b\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Rd|Road|Ln|Lane|Way|Ct|Court|Pl(?:aza)?|Pkwy|Parkway|Ter(?:race)?|Cir(?:cle)?)\b\.?/gi,
      "[REDACTED]"
    );

    // Replace email addresses — handles + addressing and subdomains
    cleaned = cleaned.replace(
      /\b[\w.+%-]+@[\w.-]+\.\w{2,}\b/g,
      "[REDACTED]"
    );

    // Replace EBT/welfare ID numbers (state-specific patterns)
    cleaned = cleaned.replace(/\b[A-Z]{2}\d{7,}\b/g, "[REDACTED]");

    return cleaned;
  }

  /**
   * Restore display name in AI response for the applicant.
   */
  restore(aiResponse) {
    let restored = aiResponse;
    for (const [realName, placeholder] of this.mappings) {
      restored = restored.replaceAll(placeholder, realName);
    }
    return restored;
  }

  /**
   * Add a name → placeholder mapping.
   */
  addMapping(realValue, placeholder) {
    if (realValue && realValue.length > 1) {
      this.mappings.set(realValue, placeholder);
    }
  }

  /**
   * Strip PII from an entire conversation history array.
   */
  stripConversation(messages) {
    return messages.map((msg) => ({
      ...msg,
      content: typeof msg.content === "string" ? this.strip(msg.content) : msg.content,
    }));
  }

  clear() {
    this.mappings.clear();
  }
}

module.exports = { PIIStripper };
