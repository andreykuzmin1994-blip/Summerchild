/**
 * Database Retry Logic — resilient Prisma operations with exponential backoff.
 *
 * County compliance notes:
 * - Transient database errors (connection drops, deadlocks) should not cause
 *   data loss for an in-progress intake session
 * - Retries are logged for operational visibility
 * - Max 3 retries with exponential backoff (200ms, 400ms, 800ms)
 * - Only retries on known-transient Prisma error codes
 *
 * Prisma transient error codes:
 *   P1001 — Can't reach database server
 *   P1002 — Database server reached but timed out
 *   P1008 — Operations timed out
 *   P1017 — Server has closed the connection
 *   P2034 — Transaction failed due to write conflict or deadlock
 */

const { child } = require("./logger");

const log = child("db-retry");

const TRANSIENT_PRISMA_CODES = new Set([
  "P1001", // Can't reach database server
  "P1002", // Database server timed out
  "P1008", // Operations timed out
  "P1017", // Server closed the connection
  "P2034", // Write conflict / deadlock
]);

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 200;

/**
 * Determine if an error is a transient database error worth retrying.
 */
function isTransientError(error) {
  if (error.code && TRANSIENT_PRISMA_CODES.has(error.code)) return true;

  // Network-level errors from the PostgreSQL driver
  if (error.code === "ECONNREFUSED") return true;
  if (error.code === "ECONNRESET") return true;
  if (error.code === "ETIMEDOUT") return true;

  // Prisma client known issues
  if (error.message && error.message.includes("Can't reach database server")) return true;
  if (error.message && error.message.includes("Connection pool timeout")) return true;

  return false;
}

/**
 * Execute a database operation with automatic retry on transient errors.
 *
 * @param {Function} operation - Async function that performs the database operation
 * @param {Object} options - Configuration options
 * @param {string} options.context - Description of the operation (for logging)
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelayMs - Base delay for exponential backoff (default: 200ms)
 * @param {string} options.correlationId - Optional correlation ID for log tracing
 * @returns {Promise<*>} Result of the operation
 */
async function withRetry(operation, options = {}) {
  const {
    context = "db-operation",
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    correlationId,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === maxRetries) {
        if (attempt > 0) {
          log.error("Database operation failed after retries", {
            context,
            correlationId,
            attempts: attempt + 1,
            errorCode: error.code,
            error: error.message,
          });
        }
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      log.warn("Transient database error — retrying", {
        context,
        correlationId,
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        errorCode: error.code,
        error: error.message,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = {
  withRetry,
  isTransientError,
  TRANSIENT_PRISMA_CODES,
};
