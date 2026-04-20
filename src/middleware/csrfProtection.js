/**
 * CSRF defense for cookie-authenticated mutations (NIST SC-7 / OWASP).
 *
 * Primary defense for cookie auth is SameSite=strict on the session cookie
 * (set in src/lib/cookies.js). This middleware adds belt-and-suspenders
 * Origin-header verification on state-changing methods.
 *
 * Policy on POST/PUT/PATCH/DELETE:
 *   - If Origin header is present, it MUST equal process.env.CORS_ORIGIN
 *     (CSV supported so a future multi-origin config Just Works).
 *   - "null" Origin (sandboxed iframes, file://) is rejected.
 *   - If no Origin header, accept only if Authorization: Bearer is present
 *     (legitimate non-browser clients; cookie-CSRF does not apply).
 *   - Otherwise 403 + audit.
 *
 * We do NOT use Referer as a fallback: helmet sets Referrer-Policy:
 * no-referrer (src/app.js), so our own clients may omit it legitimately.
 * Modern browsers always send Origin on cross-origin POSTs.
 */

const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { child } = require("../services/logger");

const log = child("csrf");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedOrigins() {
  const raw = process.env.CORS_ORIGIN || "http://localhost:5173";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin || origin === "null") return false;
  return allowedOrigins().includes(origin);
}

function csrfProtection(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const origin = req.get("Origin");
  const hasBearer = (req.get("Authorization") || "").startsWith("Bearer ");

  let ok = false;
  let reason;

  if (origin) {
    ok = isAllowedOrigin(origin);
    reason = ok ? "origin_ok" : (origin === "null" ? "null_origin" : "origin_mismatch");
  } else if (hasBearer) {
    ok = true;
    reason = "bearer_auth";
  } else {
    reason = "no_origin_no_bearer";
  }

  if (!ok) {
    log.warn("CSRF blocked", { method: req.method, path: req.path, reason, ip: req.ip });
    logAuditEvent({
      type: EVENTS.CSRF_BLOCKED,
      actorType: ACTORS.SYSTEM,
      actorId: "csrf-middleware",
      ip: req.ip,
      details: { method: req.method, path: req.path, reason },
    }).catch(() => {});
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  next();
}

module.exports = { csrfProtection, isAllowedOrigin, allowedOrigins };
