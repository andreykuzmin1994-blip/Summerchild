/**
 * PII Stripping Layer — strips all personally identifiable information
 * before any data is sent to the Claude API.
 *
 * The mapping table stays in the county's database, never leaves.
 * Claude only sees: income figures, household size, expense amounts,
 * age ranges, relationship types.
 */
class PIIStripper {
  constructor() {
    this.mappings = new Map();
  }

  /**
   * Strip PII from text before sending to AI.
   */
  strip(text) {
    let cleaned = text;

    // Replace mapped names with role labels
    for (const [realName, placeholder] of this.mappings) {
      cleaned = cleaned.replaceAll(realName, placeholder);
    }

    // Replace SSN patterns
    cleaned = cleaned.replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[SSN_REDACTED]");

    // Replace phone patterns
    cleaned = cleaned.replace(
      /\b\(?\d{3}\)?[-.)\s]?\d{3}[-.)\s]?\d{4}\b/g,
      "[PHONE_REDACTED]"
    );

    // Replace street addresses (heuristic: number + street name patterns)
    cleaned = cleaned.replace(
      /\b\d+\s+[A-Z][a-zA-Z]+\s+(St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy)\b\.?/gi,
      "[ADDRESS_REDACTED]"
    );

    // Replace email addresses
    cleaned = cleaned.replace(
      /\b[\w.-]+@[\w.-]+\.\w+\b/g,
      "[EMAIL_REDACTED]"
    );

    // Replace dates of birth (keep month/year, strip day)
    cleaned = cleaned.replace(
      /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{4})\b/g,
      (match, month, day, year) => `${month}/XX/${year}`
    );

    return cleaned;
  }

  /**
   * Restore PII in AI response for display to the applicant.
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
   * Build mappings from intake data.
   */
  buildFromIntake(applicant, householdMembers) {
    if (applicant) {
      if (applicant.firstName) this.addMapping(applicant.firstName, "[APPLICANT_FIRST]");
      if (applicant.lastName) this.addMapping(applicant.lastName, "[APPLICANT_LAST]");
      const fullName = `${applicant.firstName} ${applicant.lastName}`.trim();
      if (fullName.length > 1) this.addMapping(fullName, "[APPLICANT]");
      if (applicant.phone) this.addMapping(applicant.phone, "[PHONE_REDACTED]");
      if (applicant.email) this.addMapping(applicant.email, "[EMAIL_REDACTED]");
      if (applicant.addressStreet) this.addMapping(applicant.addressStreet, "[ADDRESS_REDACTED]");
    }

    if (householdMembers) {
      householdMembers.forEach((member, index) => {
        const label = `[MEMBER_${index + 1}]`;
        if (member.firstName) this.addMapping(member.firstName, `${label}_FIRST`);
        if (member.lastName) this.addMapping(member.lastName, `${label}_LAST`);
        const fullName = `${member.firstName} ${member.lastName}`.trim();
        if (fullName.length > 1) this.addMapping(fullName, label);
      });
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
