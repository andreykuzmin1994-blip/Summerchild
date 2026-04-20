// Account-lockout state machine (NIST AC-7, IA-5).
// Backlog item #1 in docs/SECURITY_REGULATIONS.md.
//
// Pure helpers — no I/O. The route layer owns the DB writes and audit events.
// Kept as its own module so the state rules are unit-testable without mocking
// Prisma or Express.

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

function isAccountLocked(caseworker, now = new Date()) {
  return !!(caseworker?.lockedUntil && caseworker.lockedUntil > now);
}

// Returns true when a prior lock has elapsed and the counter is still >0.
// The login handler uses this to give the user a fresh N-attempt window
// instead of re-locking them on the next bad password.
function hasExpiredLock(caseworker, now = new Date()) {
  return !!(caseworker?.lockedUntil && caseworker.lockedUntil <= now);
}

function reachedLockThreshold(loginFailedCount) {
  return loginFailedCount >= MAX_FAILED_LOGINS;
}

function computeLockExpiry(now = new Date()) {
  return new Date(now.getTime() + LOCKOUT_DURATION_MS);
}

module.exports = {
  MAX_FAILED_LOGINS,
  LOCKOUT_DURATION_MS,
  isAccountLocked,
  hasExpiredLock,
  reachedLockThreshold,
  computeLockExpiry,
};
