const rateLimit = require("express-rate-limit");

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Stricter limiter for AI message endpoints
const aiMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 messages per minute per session
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Please slow down — you can send up to 15 messages per minute" },
});

// Auth endpoint limiter (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

// Intake start endpoint limiter (prevent session exhaustion)
const intakeStartLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 new intakes per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many new intakes started — please wait before starting another" },
});

// Per-staff-PIN intake limiter. Runs AFTER requireStaffPin so
// req.staffPinUsed is set to the hash-salt-derived key. Defends
// against botnets rotating IPs but sharing a leaked PIN.
// Skip when no PIN was validated (dev mode, test harness).
const staffPinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // 5 intake starts per PIN per minute — generous for kiosk ops
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.staffPinUsed,
  keyGenerator: (req) => String(req.staffPinUsed || req.ip || "unknown"),
  message: {
    error: "This kiosk has started too many intakes in the last minute. Please wait a moment before starting another.",
  },
});

module.exports = { apiLimiter, aiMessageLimiter, authLimiter, intakeStartLimiter, staffPinLimiter };
