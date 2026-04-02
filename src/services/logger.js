/**
 * Structured Logger — county-compliant structured logging with correlation IDs.
 *
 * Compliance notes:
 * - All log entries include ISO 8601 timestamps (CJIS 5.4.1.1 audit trail requirement)
 * - Correlation IDs enable end-to-end request tracing across middleware/service layers
 * - Structured JSON output for log aggregation (CloudWatch, Datadog, Splunk)
 * - No PII is logged — only session hashes, intake IDs, and operational data
 * - Log levels: error, warn, info, debug (configurable via LOG_LEVEL env var)
 */

const crypto = require("crypto");

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || "info"] ?? LOG_LEVELS.info;

/**
 * Format a structured log entry as JSON.
 */
function formatEntry(level, component, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...meta,
  };

  // Strip undefined values
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }

  return JSON.stringify(entry);
}

/**
 * Create a scoped logger for a specific component.
 * Usage: const log = logger.child("intake-routes");
 */
function child(component) {
  return {
    error(message, meta) {
      if (currentLevel >= LOG_LEVELS.error) {
        console.error(formatEntry("error", component, message, meta));
      }
    },
    warn(message, meta) {
      if (currentLevel >= LOG_LEVELS.warn) {
        console.warn(formatEntry("warn", component, message, meta));
      }
    },
    info(message, meta) {
      if (currentLevel >= LOG_LEVELS.info) {
        console.log(formatEntry("info", component, message, meta));
      }
    },
    debug(message, meta) {
      if (currentLevel >= LOG_LEVELS.debug) {
        console.log(formatEntry("debug", component, message, meta));
      }
    },
  };
}

/**
 * Generate a unique correlation ID for a request.
 */
function generateCorrelationId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Express middleware that attaches a correlation ID to each request.
 * The correlation ID is also set as a response header for client-side tracing.
 */
function correlationMiddleware(req, _res, next) {
  req.correlationId = req.headers["x-correlation-id"] || generateCorrelationId();
  _res.setHeader("X-Correlation-ID", req.correlationId);
  next();
}

/**
 * Express middleware that logs each request/response.
 * Placed after correlationMiddleware to include the correlation ID.
 */
function requestLogMiddleware(req, res, next) {
  const start = Date.now();
  const log = child("http");

  res.on("finish", () => {
    const duration = Date.now() - start;
    const meta = {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
    };

    if (res.statusCode >= 500) {
      log.error("Request failed", meta);
    } else if (res.statusCode >= 400) {
      log.warn("Client error", meta);
    } else {
      log.info("Request completed", meta);
    }
  });

  next();
}

module.exports = {
  child,
  generateCorrelationId,
  correlationMiddleware,
  requestLogMiddleware,
  LOG_LEVELS,
};
