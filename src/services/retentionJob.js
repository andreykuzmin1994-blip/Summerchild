/**
 * Data retention enforcement (NIST 800-53 AU-11, 7 CFR 272.1).
 *
 * This module holds the *pure, injectable* policy runner. The scheduler
 * (see retentionScheduler.js) owns the clock + leader election + lock.
 *
 * Scope (v1):
 *   - ConversationLog cleanup: delete conversation rows whose parent intake
 *     is REVIEWED and whose *last* review (IntakeReview.reviewedAt) is older
 *     than CONVERSATION_LOG_RETENTION_DAYS.
 *
 * Scope (intentionally deferred to follow-up PRs):
 *   - Abandoned intake cleanup — blocked on schema changes:
 *       * enum IntakeStatus has no ABANDONED/TIMED_OUT values (schema.prisma:181)
 *       * child relations lack onDelete:Cascade → requires explicit ordered
 *         deletion or a migration
 *       * AuditLog.intakeId FK (schema.prisma:460) would block intake delete
 *         until SetNull migration lands
 *   - Caseworker account purge — blocked on:
 *       * IntakeReview.caseworkerId is non-nullable (schema.prisma:436) → hard
 *         delete is impossible without orphaning reviews
 *       * AU-10 non-repudiation prefers soft-delete (null PII columns, keep row)
 *
 * Safety rails (enforced here + in scheduler):
 *   - Dry-run mode: counts candidates, does NOT delete (scheduler default ON).
 *   - Circuit breaker: abort if candidate count exceeds maxRows (default 5000).
 *   - Clock skew guard: scheduler checks DB NOW() vs. app clock before we run.
 *   - Fail-closed audit writes: scheduler wraps each policy; if audit emission
 *     fails, the policy is NOT executed. (The normal auditLogger.logAuditEvent
 *     swallows errors — deliberately bypassed here.)
 *
 * County scoping: retention is intentionally cross-tenant (CLAUDE.md notes
 * countyId is mandatory for intake-data *queries*; this is a bulk
 * tenant-agnostic purge). Per-county retention knobs are a v2 change.
 */

const { withRetry } = require("./dbRetry");
const { child } = require("./logger");

const log = child("retention");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 5000;
const MIN_RETENTION_DAYS = 7; // floor: refuse obviously-wrong configs like 0 or 1

class RetentionCircuitBreakerError extends Error {
  constructor(policyName, candidateCount, cap) {
    super(
      `Retention circuit breaker tripped: policy "${policyName}" has ${candidateCount} candidates (cap=${cap}). ` +
      `Refusing to run. Investigate backlog or raise RETENTION_MAX_ROWS_PER_RUN deliberately.`
    );
    this.name = "RetentionCircuitBreakerError";
    this.policyName = policyName;
    this.candidateCount = candidateCount;
    this.cap = cap;
  }
}

class RetentionConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "RetentionConfigError";
  }
}

/**
 * Find candidate ConversationLog rows for deletion.
 *
 * Correctness:
 *   - The parent Intake must be REVIEWED.
 *   - The intake must have at least one IntakeReview row (`some`).
 *   - ALL IntakeReview rows on that intake must have reviewedAt < cutoff
 *     (`every`). This handles re-review: if a caseworker re-opens and
 *     re-reviews the intake yesterday, the *latest* reviewedAt is recent,
 *     so the logs are NOT deleted.
 *   - We select by intakeId then delete ConversationLog by intakeId set,
 *     which is a single indexed DELETE per batch (`conversation_logs`
 *     has `@@index([intakeId, turnNumber])`).
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {Date} args.cutoff
 * @param {number} args.limit
 * @returns {Promise<string[]>} intakeIds whose logs are eligible to delete
 */
async function findConversationLogCandidates({ prisma, cutoff, limit }) {
  const eligibleIntakes = await prisma.intake.findMany({
    where: {
      status: "REVIEWED",
      reviews: {
        some: {}, // must have been reviewed at least once
        every: { reviewedAt: { lt: cutoff } }, // all reviews are older than cutoff
      },
      conversationLogs: {
        some: {}, // only intakes that still have logs to purge
      },
    },
    select: { id: true },
    take: limit,
  });
  return eligibleIntakes.map((r) => r.id);
}

/**
 * Execute the ConversationLog retention policy.
 *
 * Returns a structured result the scheduler will audit-log (counts only,
 * no PII). Never throws on missing rows — returns deleted:0. Does throw
 * on circuit breaker trip and on invalid config.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {{ now: () => Date }} [args.clock]   — injectable for tests
 * @param {number} args.retentionDays
 * @param {number} [args.maxRows]
 * @param {boolean} [args.dryRun]
 * @param {string} [args.correlationId]
 * @returns {Promise<{policy, cutoff, candidateIntakes, deletedLogs, dryRun}>}
 */
async function runConversationLogPolicy({
  prisma,
  clock = Date,
  retentionDays,
  maxRows = DEFAULT_MAX_ROWS,
  dryRun = true,
  correlationId,
}) {
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `conversationLog.retentionDays must be an integer ≥ ${MIN_RETENTION_DAYS} (got ${retentionDays})`
    );
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RetentionConfigError(`conversationLog.maxRows must be a positive integer (got ${maxRows})`);
  }

  const now = new Date(clock.now());
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  // Find candidates. Take (maxRows + 1) so we can detect overflow without a
  // separate COUNT query. If we see maxRows+1, we tripped the breaker.
  const intakeIds = await withRetry(
    () => findConversationLogCandidates({ prisma, cutoff, limit: maxRows + 1 }),
    { context: "retention:conversationLog:find", correlationId }
  );

  if (intakeIds.length > maxRows) {
    throw new RetentionCircuitBreakerError("conversationLog", intakeIds.length, maxRows);
  }

  if (dryRun || intakeIds.length === 0) {
    return {
      policy: "conversationLog",
      cutoff: cutoff.toISOString(),
      retentionDays,
      candidateIntakes: intakeIds.length,
      deletedLogs: 0,
      dryRun,
    };
  }

  // Delete conversation logs for the eligible intakes. Single DELETE per
  // batch, Prisma generates `DELETE ... WHERE intakeId IN (...)`. At our
  // scale (≤5000 intakes × ~40 turns), this is a bounded statement.
  const { count } = await withRetry(
    () => prisma.conversationLog.deleteMany({ where: { intakeId: { in: intakeIds } } }),
    { context: "retention:conversationLog:delete", correlationId }
  );

  log.info("Retention purge complete", {
    policy: "conversationLog",
    candidateIntakes: intakeIds.length,
    deletedLogs: count,
    cutoff: cutoff.toISOString(),
    correlationId,
  });

  return {
    policy: "conversationLog",
    cutoff: cutoff.toISOString(),
    retentionDays,
    candidateIntakes: intakeIds.length,
    deletedLogs: count,
    dryRun: false,
  };
}

module.exports = {
  runConversationLogPolicy,
  findConversationLogCandidates,
  RetentionCircuitBreakerError,
  RetentionConfigError,
  DEFAULT_MAX_ROWS,
  MIN_RETENTION_DAYS,
};
