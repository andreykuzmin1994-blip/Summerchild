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

    // Replace SSN patterns (in case applicant volunteers one)
    cleaned = cleaned.replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[REDACTED]");

    // Replace phone patterns
    cleaned = cleaned.replace(
      /\b\(?\d{3}\)?[-.)\s]?\d{3}[-.)\s]?\d{4}\b/g,
      "[REDACTED]"
    );

    // Replace street addresses
    cleaned = cleaned.replace(
      /\b\d+\s+[A-Z][a-zA-Z]+\s+(St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy)\b\.?/gi,
      "[REDACTED]"
    );

    // Replace email addresses
    cleaned = cleaned.replace(
      /\b[\w.-]+@[\w.-]+\.\w+\b/g,
      "[REDACTED]"
    );

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
