const crypto = require("crypto");

/**
 * Kiosk staff PIN authentication.
 *
 * Before an applicant can start an intake session, a staff member
 * must enter their PIN to unlock the kiosk. This prevents random
 * public access to the intake flow even if the URL is discovered.
 *
 * PINs are stored as SHA-256 hashes in KIOSK_STAFF_PINS (comma-separated).
 * To generate a hash for PIN "1234":
 *   echo -n "1234" | sha256sum
 *
 * Multiple PINs are supported so each staff member can have their own.
 */

/**
 * Hash a PIN string for comparison.
 */
function hashPin(pin) {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

/**
 * Load configured PIN hashes from environment.
 */
function getAuthorizedPinHashes() {
  const raw = process.env.KIOSK_STAFF_PINS || "";
  if (!raw.trim()) return [];
  return raw.split(",").map((h) => h.trim().toLowerCase());
}

/**
 * Middleware: require a valid staff PIN to start an intake session.
 *
 * Expects the PIN in the request body as `staffPin`.
 * If KIOSK_STAFF_PINS is not configured, the middleware is permissive
 * in development and blocks all requests in production.
 */
function requireStaffPin(req, res, next) {
  const authorizedHashes = getAuthorizedPinHashes();

  // No PINs configured
  if (authorizedHashes.length === 0) {
    if (process.env.NODE_ENV === "production") {
      console.error("[KIOSK AUTH] KIOSK_STAFF_PINS not configured — blocking intake start in production");
      return res.status(503).json({
        error: "Kiosk not configured. Please contact your supervisor.",
      });
    }
    // In development, allow without PIN
    return next();
  }

  const { staffPin } = req.body;

  if (!staffPin) {
    return res.status(401).json({
      error: "Staff PIN required to start a new intake session",
    });
  }

  const pinHash = hashPin(staffPin);

  if (authorizedHashes.includes(pinHash)) {
    // Record which PIN was used (by hash prefix) for audit trail
    req.staffPinUsed = pinHash.slice(0, 8);
    return next();
  }

  console.warn(`[KIOSK AUTH] Invalid staff PIN attempt from ${req.ip}`);
  return res.status(401).json({
    error: "Invalid staff PIN",
  });
}

module.exports = { requireStaffPin, hashPin };
