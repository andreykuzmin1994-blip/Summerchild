const net = require("net");

/**
 * Parse a CIDR notation string into a base address (as 32-bit integer) and mask.
 * Supports both CIDR ranges ("10.0.0.0/8") and single IPs ("192.168.1.50").
 */
function parseCIDR(cidr) {
  const parts = cidr.trim().split("/");
  const ip = parts[0];
  const prefixLen = parts[1] !== undefined ? parseInt(parts[1], 10) : 32;

  if (!net.isIPv4(ip) || prefixLen < 0 || prefixLen > 32) {
    return null;
  }

  const ipInt = ipToInt(ip);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  const network = (ipInt & mask) >>> 0;

  return { network, mask, prefixLen, raw: cidr.trim() };
}

/**
 * Convert a dotted IPv4 string to a 32-bit unsigned integer.
 */
function ipToInt(ip) {
  const octets = ip.split(".").map(Number);
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * Check whether an IPv4 address falls within a parsed CIDR range.
 */
function isInRange(ip, cidrParsed) {
  if (!net.isIPv4(ip)) return false;
  const ipInt = ipToInt(ip);
  return ((ipInt & cidrParsed.mask) >>> 0) === cidrParsed.network;
}

/**
 * Normalize an IP address from Express req.ip.
 * Handles IPv4-mapped IPv6 addresses (::ffff:10.0.0.1 → 10.0.0.1)
 * and the loopback variants.
 */
function normalizeIP(ip) {
  if (!ip) return null;
  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  // IPv6 loopback
  if (ip === "::1") return "127.0.0.1";
  return ip;
}

/**
 * Build the IP allowlist middleware.
 *
 * Reads ALLOWED_IP_RANGES from environment as a comma-separated list of
 * CIDR ranges. If not set, the middleware is permissive (allows all) so
 * development isn't blocked. In production, an empty or missing value
 * logs a warning on each request.
 *
 * Loopback (127.0.0.0/8) is always allowed so health checks work.
 */
function ipAllowlistMiddleware(req, res, next) {
  const config = process.env.ALLOWED_IP_RANGES;

  // No allowlist configured — allow all but warn in production
  if (!config || config.trim() === "") {
    if (process.env.NODE_ENV === "production") {
      console.warn("[IP ALLOWLIST] ALLOWED_IP_RANGES not set — all IPs are permitted. This is unsafe in production.");
    }
    return next();
  }

  const clientIP = normalizeIP(req.ip);

  // Always allow loopback for health checks and local dev
  if (clientIP && clientIP.startsWith("127.")) {
    return next();
  }

  if (!clientIP || !net.isIPv4(clientIP)) {
    console.warn(`[IP ALLOWLIST] Rejected non-IPv4 address: ${req.ip}`);
    return res.status(403).json({ error: "Access denied" });
  }

  const ranges = config.split(",").map(parseCIDR).filter(Boolean);

  for (const range of ranges) {
    if (isInRange(clientIP, range)) {
      return next();
    }
  }

  console.warn(`[IP ALLOWLIST] Rejected request from ${clientIP}`);
  return res.status(403).json({ error: "Access denied" });
}

module.exports = { ipAllowlistMiddleware, parseCIDR, ipToInt, isInRange, normalizeIP };
