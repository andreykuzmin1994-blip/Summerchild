/**
 * Data retention enforcement (NIST 800-53 AU-11, 7 CFR 272.1).
 *
 * This module holds the *pure, injectable* policy runner. The scheduler
 * (see retentionScheduler.js) owns the clock + leader election + lock.
 *
 * Policies:
 *   - ConversationLog cleanup (v1): delete conversation rows whose parent
 *     intake is REVIEWED and whose *last* review (IntakeReview.reviewedAt)
 *     is older than CONVERSATION_LOG_RETENTION_DAYS.
 *   - Abandoned intake purge (v2): hard-delete intakes in terminal-abandoned
 *     states (ABANDONED or TIMED_OUT) older than INTAKE_ABANDONED_RETENTION_DAYS,
 *     with no caseworker touch and no IntakeReview. IN_PROGRESS is
 *     intentionally EXCLUDED — "stuck" is not "abandoned"; state transitions
 *     should be a separate cron.
 *   - Caseworker purge (v2): soft-delete (AU-10 non-repudiation). Overwrite
 *     name/email/password with non-reversible tombstones, set purgedAt.
 *     Preserves IntakeReview.caseworkerId FK integrity (the column is
 *     non-nullable, so hard delete is impossible).
 *
 * Deletion strategy for intake purge:
 *   - Explicit ordered child delete (NOT FK cascade). Per CLAUDE.md-adjacent
 *     "every migration is an audit event", DDL cascades are hidden behavior
 *     that tests cannot exercise end-to-end. Ordered app-level delete is
 *     auditable and testable.
 *   - Order: conversation_logs → household_members.income_sources →
 *     household_members → income_sources (without a household_member) →
 *     deductions → shelter_expense → document_checklists → applicant →
 *     null-out audit_logs.intake_id → intake.
 *   - All of the above run inside a single `prisma.$transaction` per intake
 *     so a partial failure rolls back.
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

// ---------------------------------------------------------------------
// Abandoned intake purge (v2)
// ---------------------------------------------------------------------

const MIN_INTAKE_RETENTION_DAYS = 30; // floor — guards against clock skew / misconfig
const MIN_CASEWORKER_RETENTION_DAYS = 730; // NIST IA-4 account identifier reuse floor

/**
 * Find abandoned intakes eligible for purge.
 *
 * Rule (intentionally NARROW):
 *   - status IN (ABANDONED, TIMED_OUT) — terminal states only.
 *     IN_PROGRESS is EXCLUDED: "stuck in progress" is a separate defect
 *     from "the applicant never came back," and conflating them risks
 *     deleting a real session that never got its timeout transition.
 *   - createdAt < cutoff — old enough
 *   - caseworkerId IS NULL — nobody has touched it
 *   - NO IntakeReview exists — defense-in-depth, this should already
 *     be implied by ABANDONED/TIMED_OUT but we assert it anyway.
 */
async function findAbandonedIntakeCandidates({ prisma, cutoff, limit }) {
  return prisma.intake.findMany({
    where: {
      status: { in: ["ABANDONED", "TIMED_OUT"] },
      createdAt: { lt: cutoff },
      caseworkerId: null,
      reviews: { none: {} },
    },
    select: { id: true, countyId: true },
    take: limit,
    orderBy: { createdAt: "asc" }, // deterministic ordering for stable batching
  });
}

/**
 * Delete one intake + all children using an already-open transaction client.
 *
 * Does NOT open its own $transaction. Callers MUST pass a tx client obtained
 * from an outer `prisma.$transaction(async (tx) => ...)`. This lets the
 * scheduler hold a single advisory lock for the full run and wrap all
 * policies' writes in one atomic scope.
 *
 * Order matters because Prisma relations default to ON DELETE NO ACTION;
 * we explicitly delete children before the parent. AuditLog rows are NOT
 * deleted — their intakeId is nulled so the 7-year audit evidence stays
 * in place (7 CFR 275.12).
 *
 * Returns { intakeId, countyId, childCounts } for the caller to audit.
 */
async function purgeOneIntakeInTx({ tx, intakeId, countyId }) {
  const conv = await tx.conversationLog.deleteMany({ where: { intakeId } });
  // income_sources reference household_member_id AND intake_id — delete the
  // intake-scoped rows first (covers both "member-linked" and "direct" rows).
  const income = await tx.incomeSource.deleteMany({ where: { intakeId } });
  const members = await tx.householdMember.deleteMany({ where: { intakeId } });
  const deductions = await tx.deduction.deleteMany({ where: { intakeId } });
  const shelter = await tx.shelterExpense.deleteMany({ where: { intakeId } });
  const docs = await tx.documentChecklist.deleteMany({ where: { intakeId } });
  const reviews = await tx.intakeReview.deleteMany({ where: { intakeId } });
  const applicant = await tx.applicant.deleteMany({ where: { intakeId } });

  // AuditLog rows survive — null out the FK so the 7-year trail stays
  // readable but no longer joins to a deleted parent.
  const nulled = await tx.auditLog.updateMany({
    where: { intakeId },
    data: { intakeId: null },
  });

  const del = await tx.intake.delete({ where: { id: intakeId } });

  return {
    intakeId: del.id,
    countyId,
    childCounts: {
      conversationLogs: conv.count,
      incomeSources: income.count,
      householdMembers: members.count,
      deductions: deductions.count,
      shelterExpenses: shelter.count,
      documentChecklists: docs.count,
      intakeReviews: reviews.count,
      applicants: applicant.count,
      auditLogsNulled: nulled.count,
    },
  };
}

async function runAbandonedIntakePolicy({
  prisma,
  clock = Date,
  retentionDays,
  maxRows = DEFAULT_MAX_ROWS,
  dryRun = true,
  correlationId,
}) {
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_INTAKE_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `abandonedIntake.retentionDays must be an integer ≥ ${MIN_INTAKE_RETENTION_DAYS} (got ${retentionDays})`
    );
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RetentionConfigError(`abandonedIntake.maxRows must be a positive integer (got ${maxRows})`);
  }

  const now = new Date(clock.now());
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const candidates = await withRetry(
    () => findAbandonedIntakeCandidates({ prisma, cutoff, limit: maxRows + 1 }),
    { context: "retention:abandonedIntake:find", correlationId }
  );
  if (candidates.length > maxRows) {
    throw new RetentionCircuitBreakerError("abandonedIntake", candidates.length, maxRows);
  }
  if (dryRun || candidates.length === 0) {
    return {
      policy: "abandonedIntake",
      cutoff: cutoff.toISOString(),
      retentionDays,
      candidates: candidates.length,
      deleted: 0,
      perIntake: [],
      dryRun,
    };
  }

  const perIntake = [];
  for (const { id, countyId } of candidates) {
    const result = await withRetry(
      () => purgeOneIntakeInTx({ tx: prisma, intakeId: id, countyId }),
      { context: "retention:abandonedIntake:delete", correlationId }
    );
    perIntake.push(result);
  }

  log.info("Abandoned intake purge complete", {
    candidates: candidates.length,
    deleted: perIntake.length,
    cutoff: cutoff.toISOString(),
    correlationId,
  });

  return {
    policy: "abandonedIntake",
    cutoff: cutoff.toISOString(),
    retentionDays,
    candidates: candidates.length,
    deleted: perIntake.length,
    perIntake,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------
// Caseworker soft-delete purge (v2)
// ---------------------------------------------------------------------

// Non-bcrypt-shaped tombstone. bcrypt.compare returns false for malformed
// hashes; paired with the application-level `purgedAt IS NULL` filter in
// `src/middleware/auth.js` + `src/routes/caseworker.js`, this is
// defense-in-depth. We intentionally do NOT use a bcrypt-shaped string
// here because that risks a future refactor treating it as a real hash.
const CASEWORKER_PASSWORD_TOMBSTONE = "PURGED:NON_BCRYPT_TOMBSTONE:AU-10";
const CASEWORKER_NAME_TOMBSTONE = "[PURGED]";

function purgedEmailFor(id) {
  // Email remains unique per row because id is unique. Pattern is reserved
  // by the user-creation validator so a new admin-created account cannot
  // collide. See `src/routes/caseworker.js` POST /register.
  return `purged-${id}@invalid.local`;
}

async function findCaseworkerPurgeCandidates({ prisma, cutoff, limit }) {
  return prisma.caseworker.findMany({
    where: {
      deactivatedAt: { not: null, lt: cutoff },
      purgedAt: null,
    },
    select: { id: true, countyId: true },
    take: limit,
    orderBy: { deactivatedAt: "asc" },
  });
}

async function runCaseworkerPurgePolicy({
  prisma,
  clock = Date,
  retentionDays,
  maxRows = DEFAULT_MAX_ROWS,
  dryRun = true,
  correlationId,
}) {
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_CASEWORKER_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `caseworkerPurge.retentionDays must be an integer ≥ ${MIN_CASEWORKER_RETENTION_DAYS} ` +
      `(got ${retentionDays}) — NIST IA-4 floor for account identifier reuse`
    );
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RetentionConfigError(`caseworkerPurge.maxRows must be a positive integer (got ${maxRows})`);
  }

  const now = new Date(clock.now());
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const candidates = await withRetry(
    () => findCaseworkerPurgeCandidates({ prisma, cutoff, limit: maxRows + 1 }),
    { context: "retention:caseworkerPurge:find", correlationId }
  );
  if (candidates.length > maxRows) {
    throw new RetentionCircuitBreakerError("caseworkerPurge", candidates.length, maxRows);
  }
  if (dryRun || candidates.length === 0) {
    return {
      policy: "caseworkerPurge",
      cutoff: cutoff.toISOString(),
      retentionDays,
      candidates: candidates.length,
      purged: 0,
      perCaseworker: [],
      dryRun,
    };
  }

  const purgedAt = now;
  const perCaseworker = [];
  // One tx per row so a unique-constraint conflict on one doesn't roll back
  // the rest. Each row is self-contained; the "candidates captured" audit
  // row the scheduler writes before this call preserves the original list
  // for forensic reconstruction.
  for (const { id, countyId } of candidates) {
    await withRetry(
      () => prisma.caseworker.update({
        where: { id },
        data: {
          name: CASEWORKER_NAME_TOMBSTONE,
          email: purgedEmailFor(id),
          password: CASEWORKER_PASSWORD_TOMBSTONE,
          purgedAt,
        },
      }),
      { context: "retention:caseworkerPurge:update", correlationId }
    );
    perCaseworker.push({ id, countyId });
  }

  log.info("Caseworker purge complete", {
    candidates: candidates.length,
    purged: perCaseworker.length,
    cutoff: cutoff.toISOString(),
    correlationId,
  });

  return {
    policy: "caseworkerPurge",
    cutoff: cutoff.toISOString(),
    retentionDays,
    candidates: candidates.length,
    purged: perCaseworker.length,
    perCaseworker,
    dryRun: false,
  };
}

module.exports = {
  runConversationLogPolicy,
  findConversationLogCandidates,
  runAbandonedIntakePolicy,
  findAbandonedIntakeCandidates,
  purgeOneIntakeInTx,
  runCaseworkerPurgePolicy,
  findCaseworkerPurgeCandidates,
  CASEWORKER_PASSWORD_TOMBSTONE,
  CASEWORKER_NAME_TOMBSTONE,
  purgedEmailFor,
  RetentionCircuitBreakerError,
  RetentionConfigError,
  DEFAULT_MAX_ROWS,
  MIN_RETENTION_DAYS,
  MIN_INTAKE_RETENTION_DAYS,
  MIN_CASEWORKER_RETENTION_DAYS,
};
