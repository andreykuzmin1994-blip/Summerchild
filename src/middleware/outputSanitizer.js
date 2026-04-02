/**
 * Output Sanitizer — prevents stored XSS and AI output manipulation.
 *
 * Two responsibilities:
 * 1. Sanitize user input before storing in conversation logs (prevents stored XSS
 *    when caseworkers view conversation transcripts in the dashboard).
 * 2. Sanitize AI responses to prevent injected CUSHION_DATA blocks from
 *    corrupting intake records (defense-in-depth against prompt injection).
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

module.exports = {
  sanitizeForDisplay,
  validateDataBlockCount,
  sanitizeAIResponse,
  MAX_DATA_BLOCKS_PER_RESPONSE,
};
