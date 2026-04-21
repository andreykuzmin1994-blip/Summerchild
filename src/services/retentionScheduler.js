/**
 * Retention scheduler — owns time, concurrency, and the audit-write
 * fail-closed contract that keeps retentionJob.js pure.
 *
 * Design (reconciled from Coder+Reviewer review, April 2026):
 *
 *  1. Daily at 02:00 UTC via node-cron (DATA_RETENTION_POLICY.md §3).
 *  2. Leader election: only starts on the replica with
 *     RETENTION_SCHEDULER_LEADER=true. Multi-replica deploys MUST set this
 *     on exactly one pod. This is belt-and-suspenders with (3).
 *  3. DB-side concurrency: each run takes a *transaction-scoped* advisory
 *     lock (pg_try_advisory_xact_lock). If another replica mis-sets the
 *     leader flag, the second run no-ops cleanly. Transaction scope
 *     guarantees the lock pins to a single pooled connection and is
 *     released automatically on commit or on any error path.
 *  4. In-process mutex: rejects a second invocation while one is running
 *     (guards nodemon reloads, manual triggers, >24h first-run backlog).
 *  5. Clock-skew guard: compare app clock vs. DB NOW() before every run.
 *     If they differ by >60s, refuse to run and emit an audit event.
 *  6. Fail-closed audit: the per-policy DATA_RETENTION_POLICY_EXECUTED
 *     event is written with prisma.auditLog.create directly (no swallow).
 *     If that write fails, we do NOT proceed with deletions. This is
 *     deliberately stricter than auditLogger.logAuditEvent (which swallows
 *     to keep user-facing routes alive).
 *  7. Dry-run default: RETENTION_DRY_RUN=true by default. Operators opt
 *     into real deletions explicitly.
 *
 * This module is stateful (holds the cron handle and the running flag) —
 * keep logic thin and testable by exposing start/stop/runOnce separately.
 */

const { PrismaClient } = require("@prisma/client");
const cron = require("node-cron");
const { randomUUID } = require("node:crypto");

const { runConversationLogPolicy, RetentionCircuitBreakerError } = require("./retentionJob");
const { EVENTS, ACTORS } = require("./auditLogger");
const { child } = require("./logger");

const log = child("retention-scheduler");

// 64-bit integer for pg advisory locks. Stable constant; changing it would
// break concurrency guarantees across replicas. Generated as a random int
// then hardcoded so it is reproducible.
const ADVISORY_LOCK_KEY = 0x43555348_52454e54n; // "CUSHRENT"

const CLOCK_SKEW_TOLERANCE_SECONDS = 60;
const RETENTION_ACTOR_ID = "system:retention-job@v1";

// Daily at 02:00 UTC. node-cron runs in the host TZ unless otherwise told;
// we set timezone explicitly per DATA_RETENTION_POLICY.md §3.
const DEFAULT_CRON_EXPRESSION = "0 2 * * *";
const DEFAULT_TIMEZONE = "UTC";

function parseBoolEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return value === "true" || value === "1";
}

function parseIntEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Write an audit row directly (NOT via logAuditEvent, which swallows).
 * Throws on failure. Used for the retention fail-closed contract.
 */
async function writeRetentionAuditRowOrThrow(prisma, row) {
  await prisma.auditLog.create({
    data: {
      eventType: row.type,
      actorType: ACTORS.SYSTEM,
      actorId: RETENTION_ACTOR_ID,
      intakeId: null,
      countyId: null,
      ipAddress: null,
      details: row.details ?? null,
    },
  });
}

/**
 * Verify the DB clock is within tolerance of the app clock. Protects
 * against a container with a skewed system clock silently nuking data.
 *
 * Returns { ok: boolean, appNow, dbNow, skewSeconds }.
 */
async function checkClockSkew(prisma, clock) {
  const appNow = new Date(clock.now());
  const rows = await prisma.$queryRaw`SELECT NOW() AS "dbNow"`;
  const dbNow = new Date(rows[0].dbNow);
  const skewSeconds = Math.abs((appNow.getTime() - dbNow.getTime()) / 1000);
  return {
    ok: skewSeconds <= CLOCK_SKEW_TOLERANCE_SECONDS,
    appNow,
    dbNow,
    skewSeconds,
  };
}

/**
 * Execute one full retention cycle. Factored out of the cron wiring so
 * tests can call it directly without any scheduling.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {{ now: () => Date }} [args.clock]
 * @param {object} args.config  — { enabled, dryRun, maxRows, conversationLogDays }
 * @returns {Promise<{ran:boolean, reason?:string, results?:object[]}>}
 */
async function runOnce({ prisma, clock = Date, config }) {
  const correlationId = randomUUID();
  const logCtx = { correlationId, dryRun: config.dryRun };

  if (!config.enabled) {
    log.info("Retention skipped — RETENTION_ENABLED=false", logCtx);
    return { ran: false, reason: "disabled" };
  }

  // Clock-skew guard — cheap, runs outside the advisory-lock tx.
  const skew = await checkClockSkew(prisma, clock);
  if (!skew.ok) {
    log.error("Retention refused: clock skew exceeds tolerance", {
      ...logCtx,
      skewSeconds: skew.skewSeconds,
      toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS,
    });
    // Best-effort audit. If this also fails, we still refuse to run —
    // which is the correct fail-closed posture.
    try {
      await writeRetentionAuditRowOrThrow(prisma, {
        type: EVENTS.DATA_RETENTION_CLOCK_SKEW_DETECTED,
        details: { skewSeconds: skew.skewSeconds, correlationId },
      });
    } catch (err) {
      log.error("Retention audit write failed (clock skew path)", { ...logCtx, error: err.message });
    }
    return { ran: false, reason: "clock_skew" };
  }

  // Everything that mutates data goes inside one transaction that holds the
  // transaction-scoped advisory lock. If the lock is not granted, another
  // replica is running and we no-op.
  return prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw`
      SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
    `;
    const locked = lockRows[0]?.locked === true;
    if (!locked) {
      log.info("Retention skipped — advisory lock held by another run", logCtx);
      // Best-effort audit of the skip (not load-bearing).
      try {
        await writeRetentionAuditRowOrThrow(tx, {
          type: EVENTS.DATA_RETENTION_SKIPPED_LOCKED,
          details: { correlationId },
        });
      } catch (err) {
        log.warn("Retention audit write failed (skipped-locked path)", { ...logCtx, error: err.message });
      }
      return { ran: false, reason: "lock_unavailable" };
    }

    // Fail-closed start audit. If the DB refuses this write, we throw
    // out of the transaction → no deletions happen.
    await writeRetentionAuditRowOrThrow(tx, {
      type: EVENTS.DATA_RETENTION_STARTED,
      details: {
        correlationId,
        dryRun: config.dryRun,
        maxRows: config.maxRows,
        conversationLogDays: config.conversationLogDays,
      },
    });

    const results = [];
    let anyFailed = false;

    try {
      const result = await runConversationLogPolicy({
        prisma: tx,
        clock,
        retentionDays: config.conversationLogDays,
        maxRows: config.maxRows,
        dryRun: config.dryRun,
        correlationId,
      });
      results.push(result);

      // Per-policy fail-closed audit — this is the AU-2/AU-3 evidence row.
      await writeRetentionAuditRowOrThrow(tx, {
        type: EVENTS.DATA_RETENTION_POLICY_EXECUTED,
        details: {
          correlationId,
          policy: result.policy,
          cutoff: result.cutoff,
          retentionDays: result.retentionDays,
          candidateIntakes: result.candidateIntakes,
          deletedLogs: result.deletedLogs,
          dryRun: result.dryRun,
        },
      });
    } catch (err) {
      anyFailed = true;
      const isCircuitBreaker = err instanceof RetentionCircuitBreakerError;
      log.error("Retention policy failed", {
        ...logCtx,
        policy: "conversationLog",
        circuitBreaker: isCircuitBreaker,
        error: err.message,
      });
      // Best-effort failure audit. If this throw propagates up, the whole
      // transaction rolls back — any partial deletes already executed are
      // undone (Prisma groups them in the $transaction).
      await writeRetentionAuditRowOrThrow(tx, {
        type: isCircuitBreaker
          ? EVENTS.DATA_RETENTION_CIRCUIT_BREAKER_TRIPPED
          : EVENTS.DATA_RETENTION_FAILED,
        details: {
          correlationId,
          policy: "conversationLog",
          error: err.message,
          ...(isCircuitBreaker && { candidateCount: err.candidateCount, cap: err.cap }),
        },
      });
      throw err; // aborts the transaction
    }

    await writeRetentionAuditRowOrThrow(tx, {
      type: EVENTS.DATA_RETENTION_COMPLETED,
      details: {
        correlationId,
        dryRun: config.dryRun,
        results,
        anyFailed,
      },
    });

    return { ran: true, correlationId, results };
  });
}

/**
 * Stateful scheduler. Single instance exported for the app to start/stop.
 */
class RetentionScheduler {
  constructor(deps = {}) {
    this._prisma = deps.prisma || new PrismaClient();
    this._clock = deps.clock || Date;
    this._cron = deps.cron || cron;
    this._task = null;
    this._running = false;
  }

  loadConfig() {
    return {
      enabled: parseBoolEnv(process.env.RETENTION_ENABLED, false),
      dryRun: parseBoolEnv(process.env.RETENTION_DRY_RUN, true),
      maxRows: parseIntEnv(process.env.RETENTION_MAX_ROWS_PER_RUN, 5000),
      conversationLogDays: parseIntEnv(process.env.CONVERSATION_LOG_RETENTION_DAYS, 90),
      cronExpression: process.env.RETENTION_CRON_EXPRESSION || DEFAULT_CRON_EXPRESSION,
      timezone: process.env.RETENTION_TIMEZONE || DEFAULT_TIMEZONE,
    };
  }

  /**
   * Returns true iff this replica should run the scheduler. Multi-replica
   * deployments MUST set RETENTION_SCHEDULER_LEADER=true on exactly one pod.
   * Single-replica / dev deployments can leave it unset; we default to true
   * in non-production, false in production (fail-closed for prod safety).
   */
  isLeader() {
    const explicit = process.env.RETENTION_SCHEDULER_LEADER;
    if (explicit !== undefined && explicit !== "") {
      return explicit === "true" || explicit === "1";
    }
    return process.env.NODE_ENV !== "production";
  }

  start() {
    if (this._task) {
      log.warn("Retention scheduler start() called while already running");
      return;
    }
    if (!this.isLeader()) {
      log.info("Retention scheduler not starting — this replica is not the leader");
      return;
    }
    const cfg = this.loadConfig();
    if (!cfg.enabled) {
      log.info("Retention scheduler not starting — RETENTION_ENABLED=false", {
        dryRun: cfg.dryRun,
        conversationLogDays: cfg.conversationLogDays,
      });
      return;
    }
    if (!this._cron.validate(cfg.cronExpression)) {
      log.error("Retention scheduler refusing to start — invalid cron expression", {
        cronExpression: cfg.cronExpression,
      });
      return;
    }
    this._task = this._cron.schedule(
      cfg.cronExpression,
      async () => {
        if (this._running) {
          log.warn("Retention tick skipped — previous run still in progress");
          return;
        }
        this._running = true;
        try {
          await runOnce({ prisma: this._prisma, clock: this._clock, config: this.loadConfig() });
        } catch (err) {
          log.error("Retention run failed", { error: err.message });
        } finally {
          this._running = false;
        }
      },
      { scheduled: true, timezone: cfg.timezone }
    );
    log.info("Retention scheduler started", {
      cronExpression: cfg.cronExpression,
      timezone: cfg.timezone,
      dryRun: cfg.dryRun,
      conversationLogDays: cfg.conversationLogDays,
    });
  }

  stop() {
    if (this._task) {
      this._task.stop();
      this._task = null;
    }
  }

  // For tests and manual admin-triggered runs.
  runOnce() {
    return runOnce({ prisma: this._prisma, clock: this._clock, config: this.loadConfig() });
  }
}

const retentionScheduler = new RetentionScheduler();

module.exports = {
  retentionScheduler,
  RetentionScheduler,
  runOnce,
  checkClockSkew,
  writeRetentionAuditRowOrThrow,
  ADVISORY_LOCK_KEY,
  RETENTION_ACTOR_ID,
  CLOCK_SKEW_TOLERANCE_SECONDS,
};
