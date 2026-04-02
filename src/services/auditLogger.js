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
};

const ACTORS = {
  APPLICANT: "APPLICANT",
  CASEWORKER: "CASEWORKER",
  SYSTEM: "SYSTEM",
  ADMIN: "ADMIN",
};

module.exports = { logAuditEvent, EVENTS, ACTORS };
