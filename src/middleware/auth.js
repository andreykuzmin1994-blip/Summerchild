const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");

if (!process.env.JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET environment variable is required. Server cannot start without it.");
}
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
};
