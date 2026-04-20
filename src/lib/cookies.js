/**
 * Centralized cookie-options builder for auth/session cookies.
 *
 * Policy (NIST 800-53 SC-8):
 *   - Secure is ON by default — cookies are only transmitted over HTTPS.
 *   - Set ALLOW_INSECURE_COOKIES=true ONLY for local HTTP development.
 *   - In production, ALLOW_INSECURE_COOKIES=true is rejected at startup
 *     (see src/app.js). This makes the production deploy fail closed.
 *
 * Why default-secure instead of deriving from the request?
 *   - Apps behind a TLS-terminating proxy see HTTP on the internal hop;
 *     req.secure is false unless `app.set('trust proxy', ...)` is tuned
 *     exactly right. Default-secure removes that ambiguity.
 *   - Over-setting Secure is browser-enforced (cookie is dropped on HTTP),
 *     so the worst case is a misconfiguration surfacing as a clear 401 loop
 *     in dev rather than a silent session-theft vector in prod.
 *
 * `httpOnly`, `sameSite`, and `path` are fixed here so that any future
 * res.clearCookie call uses identical attributes (required for browsers
 * to actually clear the cookie).
 */
function isSecureCookieEnabled() {
  return process.env.ALLOW_INSECURE_COOKIES !== "true";
}

function buildAuthCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    secure: isSecureCookieEnabled(),
    sameSite: "strict",
    path: "/",
    ...overrides,
  };
}

module.exports = { buildAuthCookieOptions, isSecureCookieEnabled };
