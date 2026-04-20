const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");

/**
 * Validate JWT_SECRET strength (NIST 800-53 IA-5).
 *
 * A weak secret enables offline brute-force → full authentication bypass.
 * Rules (in order):
 *   1. Must be non-empty after trim.
 *   2. Length ≥ 32.
 *   3. Must not be a well-known placeholder.
 *   4. Must not be a single repeated character (e.g. "x".repeat(32)).
 *   5. Either (a) has ≥ 3 of 4 character classes, OR
 *      (b) matches a known cryptographic-random format (hex, base64,
 *      base64url) of sufficient length. This accepts `openssl rand -hex 32`
 *      output (64 lowercase hex chars, 256 bits entropy) without tripping
 *      the diversity check.
 *
 * The secret value is NEVER included in thrown error messages — only the
 * failure mode name is logged.
 *
 * Exported for direct unit testing.
 */
function validateJwtSecret(secret) {
  if (secret === null || secret === undefined || String(secret).trim().length === 0) {
    throw new Error(
      "FATAL: JWT_SECRET environment variable is required. " +
      "Generate one with: openssl rand -base64 32 (see .env.example)"
    );
  }

  if (secret.length < 32) {
    throw new Error(
      "FATAL: JWT_SECRET must be at least 32 characters. " +
      "Generate one with: openssl rand -base64 32 (see .env.example)"
    );
  }

  // Reject well-known placeholders (case-insensitive). Matches "your-secret-here",
  // "change-me", "changeme", "please-change", bare "secret"/"password"/"changeme"
  // fully, "placeholder", "example", "test-secret" / "test_secret" variants.
  const placeholderRegex = /(your[-_]?secret|change[-_]?me|placeholder|example|^secret$|^password$|test[-_]?secret)/i;
  if (placeholderRegex.test(secret)) {
    throw new Error(
      "FATAL: JWT_SECRET is a well-known placeholder. " +
      "Generate a real secret: openssl rand -base64 32 (see .env.example)"
    );
  }

  // Reject single-character repeats (e.g. "x" × 40).
  if (/^(.)\1+$/.test(secret)) {
    throw new Error(
      "FATAL: JWT_SECRET is a repeated single character — trivial to guess. " +
      "Generate one with: openssl rand -base64 32"
    );
  }

  // Format allowlist: known crypto-random outputs that may have <3 char classes.
  const isHex = /^[A-Fa-f0-9]+$/.test(secret) && secret.length >= 48;
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(secret) && secret.length >= 40;
  const isBase64url = /^[A-Za-z0-9_-]+$/.test(secret) && secret.length >= 40;
  if (isHex || isBase64 || isBase64url) {
    return; // high-entropy format accepted
  }

  const classes =
    Number(/[a-z]/.test(secret)) +
    Number(/[A-Z]/.test(secret)) +
    Number(/[0-9]/.test(secret)) +
    Number(/[^A-Za-z0-9]/.test(secret));

  if (classes < 3) {
    throw new Error(
      "FATAL: JWT_SECRET has insufficient character diversity " +
      "(need ≥3 of: uppercase, lowercase, digit, symbol). " +
      "Generate one with: openssl rand -base64 32"
    );
  }
}

validateJwtSecret(process.env.JWT_SECRET);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = "8h";

/**
 * Generate a JWT token for a caseworker.
 */
function generateToken(caseworker) {
  return jwt.sign(
    {
      id: caseworker.id,
      email: caseworker.email,
      role: caseworker.role,
      countyId: caseworker.countyId,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

/**
 * Hash a password.
 */
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

/**
 * Compare a password with a hash.
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Middleware: require authentication via JWT Bearer token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Middleware: verify JWT claims against database state.
 * Catches stale tokens where role/county changed or account was deactivated.
 */
async function requireVerifiedAuth(req, res, next) {
  // Accept token from Authorization header or httpOnly cookie
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

    // Server-side verification: check caseworker still exists and is active
    const caseworker = await prisma.caseworker.findUnique({
      where: { id: decoded.id },
      select: { id: true, countyId: true, role: true, deactivatedAt: true },
    });

    if (!caseworker || caseworker.deactivatedAt) {
      return res.status(401).json({ error: "User account is inactive or not found" });
    }

    // Verify JWT claims match current server state
    if (caseworker.countyId !== decoded.countyId || caseworker.role !== decoded.role) {
      return res.status(403).json({ error: "Token is stale — please log in again" });
    }

    req.user = decoded;
    req.caseworker = caseworker;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Middleware: require specific role(s).
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

module.exports = {
  generateToken,
  hashPassword,
  comparePassword,
  requireAuth,
  requireVerifiedAuth,
  requireRole,
  validateJwtSecret,
};
