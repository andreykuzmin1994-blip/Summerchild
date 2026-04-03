/**
 * AI Hallucination Detector — checks that AI-extracted data is grounded
 * in the actual conversation history. Flags data blocks that appear to
 * have been invented by the AI rather than stated by the applicant.
 *
 * County compliance: prevents AI hallucinations from corrupting intake
 * records and causing overpayment errors.
 */

const { child } = require("./logger");

const log = child("hallucination-detector");

/**
 * Check if extracted data blocks are grounded in the conversation.
 * Returns an array of hallucination warnings.
 *
 * @param {Array} conversationHistory - Array of {role, content} messages
 * @param {Array} extractedData - Array of data blocks from AI response
 * @returns {Array} Array of { type, field, data, severity, recommendation }
 */
function detectHallucinations(conversationHistory, extractedData) {
  const warnings = [];

  if (!extractedData || extractedData.length === 0) return warnings;

  // Collect all user messages into a single searchable string
  const userMessages = conversationHistory
    .filter((msg) => msg.role === "user")
    .map((msg) => (typeof msg.content === "string" ? msg.content : "").toLowerCase())
    .join(" ");

  for (const block of extractedData) {
    const field = block.field;
    const issues = [];

    switch (field) {
      case "household_member": {
        // Check if the member name was mentioned by the user
        if (block.display_name && !userMessages.includes(block.display_name.toLowerCase().split(" ")[0])) {
          issues.push(`Member name "${block.display_name}" not found in user messages`);
        }
        break;
      }

      case "income_source": {
        // Check if employer name or income amount was mentioned
        if (block.employer && block.employer.length > 2) {
          const employerLower = block.employer.toLowerCase();
          if (!userMessages.includes(employerLower)) {
            issues.push(`Employer "${block.employer}" not found in user messages`);
          }
        }
        // Check if the dollar amount was mentioned (as number)
        if (block.gross_per_period) {
          const amountStr = String(block.gross_per_period);
          const amountVariants = [
            amountStr,
            amountStr.replace(/\.00$/, ""),
            `$${amountStr}`,
            `$${amountStr.replace(/\.00$/, "")}`,
          ];
          const amountFound = amountVariants.some((v) => userMessages.includes(v.toLowerCase()));
          if (!amountFound) {
            issues.push(`Income amount $${block.gross_per_period} not found in user messages`);
          }
        }
        break;
      }

      case "shelter_rent":
      case "shelter_expense": {
        const rent = block.rent || block.value;
        if (rent && rent > 0) {
          const rentStr = String(rent);
          const rentVariants = [rentStr, rentStr.replace(/\.00$/, ""), `$${rentStr}`, `$${rentStr.replace(/\.00$/, "")}`];
          const rentFound = rentVariants.some((v) => userMessages.includes(v.toLowerCase()));
          if (!rentFound) {
            issues.push(`Rent amount $${rent} not found in user messages`);
          }
        }
        break;
      }
    }

    if (issues.length > 0) {
      const warning = {
        type: "POTENTIAL_HALLUCINATION",
        field,
        data: block,
        severity: "HIGH",
        issues,
        recommendation: "FLAG FOR MANUAL REVIEW — AI extracted data not grounded in applicant statements",
      };
      warnings.push(warning);
      log.warn("Potential AI hallucination detected", { field, issues });
    }
  }

  return warnings;
}

module.exports = { detectHallucinations };
