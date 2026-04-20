const { PrismaClient } = require("@prisma/client");
const { child } = require("./logger");
const { withRetry } = require("./dbRetry");

const prisma = new PrismaClient();
const log = child("audit");

/**
 * Log an audit event to the immutable audit trail.
 * The audit_log table should have no UPDATE or DELETE permissions
 * for the application database user.
 *
 * County compliance: audit records are required for SNAP QC reviews
 * (7 CFR 275.12). Retries on transient DB errors to prevent audit gaps.
 */
async function logAuditEvent(event) {
  try {
    await withRetry(
      () => prisma.auditLog.create({
        data: {
          eventType: event.type,
          actorType: event.actorType,
          actorId: event.actorId,
          intakeId: event.intakeId || null,
          countyId: event.countyId || null,
          ipAddress: event.ip || null,
          details: event.details || null,
        },
      }),
      { context: "auditLog.create", maxRetries: 2 }
    );
  } catch (error) {
    // Audit logging should never crash the application
    log.error("Failed to write audit log", {
      eventType: event.type,
      error: error.message,
    });
  }
}

/**
 * Verify that the application DB role cannot DELETE from audit_logs.
 * NIST 800-53 AU-3/AU-6: audit records must be tamper-evident.
 *
 * Uses $executeRaw (tagged template, parameterized) — never $executeRawUnsafe.
 * The WHERE predicate is a bound parameter that is always false, so even a
 * permissive DB role cannot lose data through this check.
 *
 * Returns { status, immutable, message } where status is:
 *   - "immutable": DB rejected DELETE with insufficient_privilege (42501) — desired
 *   - "mutable":   DB accepted the DELETE — SECURITY ALERT
 *   - "unknown":   other error (connection, missing table, etc.) — requires investigation
 */
async function verifyAuditLogImmutability(client = prisma) {
  const alwaysFalse = false;
  try {
    await client.$executeRaw`DELETE FROM audit_logs WHERE ${alwaysFalse}`;
    log.error("SECURITY ALERT: Audit log DELETE permission is not restricted");
    return {
      status: "mutable",
      immutable: false,
      message: "Audit logs are NOT immutable — DELETE is permitted",
    };
  } catch (error) {
    if (isInsufficientPrivilegeError(error)) {
      log.info("Audit log immutability verified — DELETE is restricted");
      return { status: "immutable", immutable: true, message: "Audit logs are immutable" };
    }
    // Any other failure (connection, missing table, transaction abort) must
    // NOT be treated as a successful immutability check.
    log.warn("Audit log immutability check failed for non-permission reason", {
      error: error.message,
      code: error.code,
    });
    return {
      status: "unknown",
      immutable: false,
      message: `Could not verify audit log immutability: ${error.message}`,
    };
  }
}

/**
 * Detect Postgres "insufficient_privilege" (SQLSTATE 42501) via Prisma error.
 * Prisma surfaces raw SQL errors via `error.code` or in `error.meta.code`;
 * the message text also contains "permission denied" on Postgres.
 */
function isInsufficientPrivilegeError(error) {
  if (!error) return false;
  const code = error.code || error?.meta?.code;
  if (code === "42501") return true;
  const msg = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return msg.includes("permission denied") || msg.includes("insufficient privilege");
}

// Event type constants
const EVENTS = {
  INTAKE_CREATED: "INTAKE_CREATED",
  INTAKE_COMPLETED: "INTAKE_COMPLETED",
  INTAKE_ABANDONED: "INTAKE_ABANDONED",
  INTAKE_TIMED_OUT: "INTAKE_TIMED_OUT",
  AI_API_CALL: "AI_API_CALL",
  INJECTION_BLOCKED: "INJECTION_BLOCKED",
  PII_STRIPPED: "PII_STRIPPED",
  CASEWORKER_LOGIN: "CASEWORKER_LOGIN",
  CASEWORKER_LOGOUT: "CASEWORKER_LOGOUT",
  CASEWORKER_VIEWED_INTAKE: "CASEWORKER_VIEWED_INTAKE",
  CASEWORKER_REVIEWED_INTAKE: "CASEWORKER_REVIEWED_INTAKE",
  CASEWORKER_CORRECTION: "CASEWORKER_CORRECTION",
  DATA_EXPORT: "DATA_EXPORT",
  ADMIN_USER_CREATED: "ADMIN_USER_CREATED",
  ADMIN_USER_MODIFIED: "ADMIN_USER_MODIFIED",
  ADMIN_USER_DEACTIVATED: "ADMIN_USER_DEACTIVATED",
  ADMIN_AUDIT_LOG_ACCESSED: "ADMIN_AUDIT_LOG_ACCESSED",
  AI_HALLUCINATION_DETECTED: "AI_HALLUCINATION_DETECTED",
  CASEWORKER_REVIEW_CONFIRMED: "CASEWORKER_REVIEW_CONFIRMED",
  FEDERAL_MATCH_CORRECTION: "FEDERAL_MATCH_CORRECTION",
  CSRF_BLOCKED: "CSRF_BLOCKED",
};

const ACTORS = {
  APPLICANT: "APPLICANT",
  CASEWORKER: "CASEWORKER",
  SYSTEM: "SYSTEM",
  ADMIN: "ADMIN",
};

module.exports = { logAuditEvent, verifyAuditLogImmutability, EVENTS, ACTORS };
