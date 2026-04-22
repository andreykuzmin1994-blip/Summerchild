import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  runConversationLogPolicy,
  runAbandonedIntakePolicy,
  runCaseworkerPurgePolicy,
  runIntakeTimeoutPolicy,
  purgeOneIntakeInTx,
  CASEWORKER_PASSWORD_TOMBSTONE,
  CASEWORKER_NAME_TOMBSTONE,
  purgedEmailFor,
  RetentionCircuitBreakerError,
  RetentionConfigError,
  MIN_RETENTION_DAYS,
  MIN_INTAKE_RETENTION_DAYS,
  MIN_CASEWORKER_RETENTION_DAYS,
  MIN_INTAKE_TIMEOUT_DAYS,
} = require("../src/services/retentionJob");

/**
 * Build a fake Prisma client that records calls. The retention job touches:
 *   - prisma.intake.findMany({ where, select, take }) → returns [{id}, ...]
 *   - prisma.conversationLog.deleteMany({ where }) → returns { count }
 */
function fakePrisma({ eligibleIntakeIds = [], deletedCount = undefined } = {}) {
  const calls = { findMany: [], deleteMany: [] };
  const client = {
    intake: {
      findMany: vi.fn(async (args) => {
        calls.findMany.push(args);
        const n = Math.min(eligibleIntakeIds.length, args.take);
        return eligibleIntakeIds.slice(0, n).map((id) => ({ id }));
      }),
    },
    conversationLog: {
      deleteMany: vi.fn(async (args) => {
        calls.deleteMany.push(args);
        return { count: deletedCount ?? eligibleIntakeIds.length * 3 };
      }),
    },
  };
  return { client, calls };
}

function fixedClock(isoString) {
  const t = new Date(isoString).getTime();
  return { now: () => t };
}

describe("runConversationLogPolicy — config validation", () => {
  it("rejects retentionDays below the floor", async () => {
    const { client } = fakePrisma();
    await expect(
      runConversationLogPolicy({ prisma: client, retentionDays: 3, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("rejects non-integer retentionDays", async () => {
    const { client } = fakePrisma();
    await expect(
      runConversationLogPolicy({ prisma: client, retentionDays: 90.5, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("rejects non-positive maxRows", async () => {
    const { client } = fakePrisma();
    await expect(
      runConversationLogPolicy({ prisma: client, retentionDays: 90, maxRows: 0, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("accepts exactly the MIN_RETENTION_DAYS floor", async () => {
    const { client } = fakePrisma();
    await expect(
      runConversationLogPolicy({ prisma: client, retentionDays: MIN_RETENTION_DAYS, dryRun: true })
    ).resolves.toMatchObject({ policy: "conversationLog" });
  });
});

describe("runConversationLogPolicy — cutoff math", () => {
  it("computes cutoff = clock.now - retentionDays * DAY", async () => {
    const { client, calls } = fakePrisma({ eligibleIntakeIds: [] });
    const clock = fixedClock("2026-04-21T00:00:00.000Z");
    await runConversationLogPolicy({
      prisma: client,
      clock,
      retentionDays: 90,
      dryRun: true,
    });
    const where = calls.findMany[0].where;
    const cutoff = where.reviews.every.reviewedAt.lt;
    // 2026-04-21 minus 90 days = 2026-01-21
    expect(cutoff.toISOString().slice(0, 10)).toBe("2026-01-21");
  });

  it("filters on status=REVIEWED with at-least-one review all older than cutoff", async () => {
    const { client, calls } = fakePrisma({ eligibleIntakeIds: ["i1"] });
    await runConversationLogPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: true,
    });
    const where = calls.findMany[0].where;
    expect(where.status).toBe("REVIEWED");
    expect(where.reviews.some).toEqual({});
    expect(where.reviews.every.reviewedAt.lt).toBeInstanceOf(Date);
    expect(where.conversationLogs.some).toEqual({});
  });
});

describe("runConversationLogPolicy — dry-run", () => {
  it("does not call deleteMany and reports candidate count only", async () => {
    const { client } = fakePrisma({ eligibleIntakeIds: ["a", "b", "c"] });
    const result = await runConversationLogPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: true,
    });
    expect(client.conversationLog.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      policy: "conversationLog",
      candidateIntakes: 3,
      deletedLogs: 0,
      dryRun: true,
    });
  });
});

describe("runConversationLogPolicy — circuit breaker", () => {
  it("throws RetentionCircuitBreakerError when candidates exceed maxRows", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `id-${i}`);
    const { client } = fakePrisma({ eligibleIntakeIds: ids });
    await expect(
      runConversationLogPolicy({
        prisma: client,
        clock: fixedClock("2026-04-21T00:00:00.000Z"),
        retentionDays: 90,
        maxRows: 10,
        dryRun: false,
      })
    ).rejects.toBeInstanceOf(RetentionCircuitBreakerError);
    // No delete should have happened before the breaker tripped.
    expect(client.conversationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("requests limit=maxRows+1 so overflow is detected without a COUNT query", async () => {
    const { client, calls } = fakePrisma({ eligibleIntakeIds: [] });
    await runConversationLogPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      maxRows: 500,
      dryRun: true,
    });
    expect(calls.findMany[0].take).toBe(501);
  });
});

describe("runConversationLogPolicy — happy path deletion", () => {
  it("deletes conversation logs scoped to the eligible intake IDs", async () => {
    const { client, calls } = fakePrisma({
      eligibleIntakeIds: ["intake-1", "intake-2"],
      deletedCount: 42,
    });
    const result = await runConversationLogPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: false,
    });
    expect(client.conversationLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(calls.deleteMany[0].where).toEqual({
      intakeId: { in: ["intake-1", "intake-2"] },
    });
    expect(result).toMatchObject({
      policy: "conversationLog",
      candidateIntakes: 2,
      deletedLogs: 42,
      dryRun: false,
    });
  });

  it("no-ops cleanly when nothing is eligible", async () => {
    const { client } = fakePrisma({ eligibleIntakeIds: [] });
    const result = await runConversationLogPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: false,
    });
    expect(client.conversationLog.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidateIntakes: 0, deletedLogs: 0 });
  });
});

// ----------------------------------------------------------------------
// Scheduler: runOnce() — concurrency, clock skew, fail-closed audit.
// ----------------------------------------------------------------------

describe("retentionScheduler.runOnce", () => {
  let runOnce;

  beforeEach(() => {
    const mod = require("../src/services/retentionScheduler");
    runOnce = mod.runOnce;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a fake Prisma client supporting all three retention policies.
   *
   * intake.findMany routes by `args.where.status`:
   *   - `"REVIEWED"` / `.reviews.every`        → conversationLog candidates
   *   - `{ in: ['ABANDONED','TIMED_OUT'] }`    → abandonedIntake candidates
   */
  function fakeTxPrisma({
    dbNowOffsetMs = 0,
    lockGranted = true,
    auditCreateThrows = false,
    conversationLogIntakeIds = [],
    abandonedIntakes = [],  // [{id, countyId}, ...]
    caseworkerCandidates = [], // [{id, countyId}, ...]
    timeoutCandidates = [], // [{id, countyId}, ...]
  } = {}) {
    const auditRows = [];

    const noopDeleteMany = (count = 1) => vi.fn(async () => ({ count }));

    const makeClient = () => {
      const client = {
        $queryRaw: vi.fn(async (strings) => {
          const sql = (strings.raw || strings).join(" ");
          if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: lockGranted }];
          if (sql.includes("NOW()")) return [{ dbNow: new Date(Date.now() + dbNowOffsetMs) }];
          throw new Error(`unexpected $queryRaw in fake: ${sql}`);
        }),
        auditLog: {
          create: vi.fn(async ({ data }) => {
            if (auditCreateThrows) throw new Error("simulated audit write failure");
            auditRows.push(data);
            return { id: `audit-${auditRows.length}`, ...data };
          }),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        intake: {
          findMany: vi.fn(async (args) => {
            const status = args.where?.status;
            if (status && typeof status === "object" && Array.isArray(status.in)) {
              // abandoned intake query
              const n = Math.min(abandonedIntakes.length, args.take);
              return abandonedIntakes.slice(0, n);
            }
            if (status === "IN_PROGRESS") {
              // intake timeout query
              const n = Math.min(timeoutCandidates.length, args.take);
              return timeoutCandidates.slice(0, n);
            }
            // conversationLog query (status: 'REVIEWED')
            const n = Math.min(conversationLogIntakeIds.length, args.take);
            return conversationLogIntakeIds.slice(0, n).map((id) => ({ id }));
          }),
          updateMany: vi.fn(async () => ({ count: timeoutCandidates.length })),
          delete: vi.fn(async (args) => ({ id: args.where.id })),
        },
        conversationLog: {
          deleteMany: vi.fn(async (args) => ({
            count: args.where.intakeId?.in?.length ?? 1,
          })),
        },
        householdMember: { deleteMany: noopDeleteMany() },
        incomeSource: { deleteMany: noopDeleteMany() },
        deduction: { deleteMany: noopDeleteMany() },
        shelterExpense: { deleteMany: noopDeleteMany() },
        documentChecklist: { deleteMany: noopDeleteMany() },
        intakeReview: { deleteMany: noopDeleteMany() },
        applicant: { deleteMany: noopDeleteMany() },
        caseworker: {
          findMany: vi.fn(async (args) => {
            const n = Math.min(caseworkerCandidates.length, args.take);
            return caseworkerCandidates.slice(0, n);
          }),
          update: vi.fn(async (args) => ({ id: args.where.id })),
        },
      };
      return client;
    };

    const outer = makeClient();
    outer.$transaction = vi.fn(async (cb) => cb(outer));
    return { prisma: outer, auditRows };
  }

  // Full config snapshot — tests that want specific policy behavior override fields.
  const FULL_CONFIG = {
    enabled: true,
    dryRun: true,
    maxRows: 100,
    conversationLogDays: 90,
    abandonedIntakeDays: 90,
    caseworkerPurgeDays: 1095,
    intakeTimeoutDays: 7,
  };

  it("returns {ran:false, reason:'disabled'} when enabled=false", async () => {
    const { prisma } = fakeTxPrisma();
    const result = await runOnce({
      prisma,
      config: { ...FULL_CONFIG, enabled: false },
    });
    expect(result).toEqual({ ran: false, reason: "disabled" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to run when DB clock differs from app clock by > tolerance", async () => {
    const { prisma, auditRows } = fakeTxPrisma({ dbNowOffsetMs: 5 * 60 * 1000 });
    const result = await runOnce({
      prisma,
      config: { ...FULL_CONFIG, dryRun: false },
    });
    expect(result).toEqual({ ran: false, reason: "clock_skew" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_CLOCK_SKEW_DETECTED");
  });

  it("no-ops when another replica already holds the advisory lock", async () => {
    const { prisma, auditRows } = fakeTxPrisma({ lockGranted: false });
    const result = await runOnce({
      prisma,
      config: { ...FULL_CONFIG, dryRun: false },
    });
    expect(result).toEqual({ ran: false, reason: "lock_unavailable" });
    // No delete attempted.
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_SKIPPED_LOCKED");
  });

  it("fails closed: if DATA_RETENTION_STARTED audit write throws, no deletions occur", async () => {
    const { prisma } = fakeTxPrisma({
      auditCreateThrows: true,
      conversationLogIntakeIds: ["a", "b"],
    });
    await expect(
      runOnce({ prisma, config: { ...FULL_CONFIG, dryRun: false } })
    ).rejects.toThrow(/audit write failure/);
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("happy path emits STARTED, four POLICY_EXECUTED rows in order, and COMPLETED", async () => {
    const { prisma, auditRows } = fakeTxPrisma({
      conversationLogIntakeIds: ["i1", "i2"],
      abandonedIntakes: [],
      caseworkerCandidates: [],
      timeoutCandidates: [],
    });
    const result = await runOnce({
      prisma,
      config: { ...FULL_CONFIG, dryRun: false },
    });
    expect(result.ran).toBe(true);
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_STARTED");
    expect(types).toContain("DATA_RETENTION_COMPLETED");
    // One POLICY_EXECUTED per policy — intakeTimeout runs FIRST so
    // transitioned rows feed abandonedIntake in the same cycle.
    const policyRows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_POLICY_EXECUTED");
    expect(policyRows).toHaveLength(4);
    const policies = policyRows.map((r) => r.details.policy);
    expect(policies).toEqual([
      "intakeTimeout",
      "conversationLog",
      "abandonedIntake",
      "caseworkerPurge",
    ]);
    for (const row of policyRows) {
      expect(row.actorType).toBe("SYSTEM");
      expect(row.actorId).toBe("system:retention-job@v1");
    }
  });

  it("emits per-intake DATA_RETENTION_INTAKE_TIMED_OUT events with countyId", async () => {
    const { prisma, auditRows } = fakeTxPrisma({
      timeoutCandidates: [
        { id: "idle-1", countyId: "county-A" },
        { id: "idle-2", countyId: "county-B" },
      ],
    });
    await runOnce({ prisma, config: { ...FULL_CONFIG, dryRun: false } });
    const rows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_INTAKE_TIMED_OUT");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.details.countyId).sort()).toEqual(["county-A", "county-B"]);
    // Must call updateMany with the status guard clause.
    expect(prisma.intake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "IN_PROGRESS" }),
        data: { status: "TIMED_OUT" },
      })
    );
  });

  it("emits per-intake DATA_RETENTION_INTAKE_PURGED with countyId", async () => {
    const { prisma, auditRows } = fakeTxPrisma({
      conversationLogIntakeIds: [],
      abandonedIntakes: [
        { id: "intake-1", countyId: "county-A" },
        { id: "intake-2", countyId: "county-B" },
      ],
      caseworkerCandidates: [],
    });
    await runOnce({ prisma, config: { ...FULL_CONFIG, dryRun: false } });
    const purgeRows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_INTAKE_PURGED");
    expect(purgeRows).toHaveLength(2);
    expect(purgeRows.map((r) => r.details.countyId).sort()).toEqual(["county-A", "county-B"]);
    expect(purgeRows[0].details).toHaveProperty("childCounts");
  });

  it("emits per-caseworker DATA_RETENTION_CASEWORKER_PURGED rows", async () => {
    const { prisma, auditRows } = fakeTxPrisma({
      conversationLogIntakeIds: [],
      abandonedIntakes: [],
      caseworkerCandidates: [
        { id: "cw-1", countyId: "county-A" },
      ],
    });
    await runOnce({ prisma, config: { ...FULL_CONFIG, dryRun: false } });
    const rows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_CASEWORKER_PURGED");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ caseworkerId: "cw-1", countyId: "county-A" });
  });

  it("dry-run path records dryRun:true and does not delete", async () => {
    const { prisma, auditRows } = fakeTxPrisma({
      conversationLogIntakeIds: ["i1"],
      abandonedIntakes: [{ id: "a1", countyId: "c" }],
      caseworkerCandidates: [{ id: "cw1", countyId: "c" }],
    });
    await runOnce({ prisma, config: { ...FULL_CONFIG, dryRun: true } });
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.intake.delete).not.toHaveBeenCalled();
    expect(prisma.caseworker.update).not.toHaveBeenCalled();
    const policyRows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_POLICY_EXECUTED");
    for (const row of policyRows) {
      expect(row.details.dryRun).toBe(true);
    }
  });

  it("a failing policy does not prevent subsequent policies from running", async () => {
    // Force conversationLog to trip the circuit breaker by returning more
    // candidates than maxRows allows. abandoned + caseworker should still run.
    const many = Array.from({ length: 12 }, (_, i) => `i-${i}`);
    const { prisma, auditRows } = fakeTxPrisma({
      conversationLogIntakeIds: many,
      abandonedIntakes: [],
      caseworkerCandidates: [],
    });
    await runOnce({ prisma, config: { ...FULL_CONFIG, maxRows: 10, dryRun: false } });
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_CIRCUIT_BREAKER_TRIPPED");
    // The breaker fires on conversationLog, but the other three POLICY_EXECUTED
    // rows should still be emitted (intakeTimeout runs first and succeeds).
    const policyRows = auditRows.filter((r) => r.eventType === "DATA_RETENTION_POLICY_EXECUTED");
    const policies = policyRows.map((r) => r.details.policy);
    expect(policies).toEqual(["intakeTimeout", "abandonedIntake", "caseworkerPurge"]);
  });
});

// ----------------------------------------------------------------------
// Scheduler: leader election + start() gating.
// ----------------------------------------------------------------------

describe("RetentionScheduler.isLeader", () => {
  const { RetentionScheduler } = require("../src/services/retentionScheduler");
  const originalLeader = process.env.RETENTION_SCHEDULER_LEADER;
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalLeader === undefined) delete process.env.RETENTION_SCHEDULER_LEADER;
    else process.env.RETENTION_SCHEDULER_LEADER = originalLeader;
    process.env.NODE_ENV = originalEnv;
  });

  it("returns true when explicitly set to 'true'", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "true";
    process.env.NODE_ENV = "production";
    const s = new RetentionScheduler({ prisma: {} });
    expect(s.isLeader()).toBe(true);
  });

  it("returns false when explicitly set to 'false'", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "false";
    process.env.NODE_ENV = "test";
    const s = new RetentionScheduler({ prisma: {} });
    expect(s.isLeader()).toBe(false);
  });

  it("defaults to false in production when unset (fail-closed)", () => {
    delete process.env.RETENTION_SCHEDULER_LEADER;
    process.env.NODE_ENV = "production";
    const s = new RetentionScheduler({ prisma: {} });
    expect(s.isLeader()).toBe(false);
  });

  it("defaults to true in non-production when unset (dev-friendly)", () => {
    delete process.env.RETENTION_SCHEDULER_LEADER;
    process.env.NODE_ENV = "development";
    const s = new RetentionScheduler({ prisma: {} });
    expect(s.isLeader()).toBe(true);
  });
});

// ----------------------------------------------------------------------
// Abandoned intake purge
// ----------------------------------------------------------------------

function fakeIntakePrisma({ candidates = [], nulledAuditCount = 1 } = {}) {
  const calls = { findMany: [], deleteMany: {}, updateMany: {}, delete: [] };
  const deleteMany = (model) => vi.fn(async (args) => {
    calls.deleteMany[model] = (calls.deleteMany[model] || []);
    calls.deleteMany[model].push(args);
    return { count: 1 };
  });
  const client = {
    intake: {
      findMany: vi.fn(async (args) => {
        calls.findMany.push(args);
        const n = Math.min(candidates.length, args.take);
        return candidates.slice(0, n);
      }),
      delete: vi.fn(async (args) => {
        calls.delete.push(args);
        return { id: args.where.id };
      }),
    },
    conversationLog: { deleteMany: deleteMany("conversationLog") },
    householdMember: { deleteMany: deleteMany("householdMember") },
    incomeSource: { deleteMany: deleteMany("incomeSource") },
    deduction: { deleteMany: deleteMany("deduction") },
    shelterExpense: { deleteMany: deleteMany("shelterExpense") },
    documentChecklist: { deleteMany: deleteMany("documentChecklist") },
    intakeReview: { deleteMany: deleteMany("intakeReview") },
    applicant: { deleteMany: deleteMany("applicant") },
    auditLog: {
      updateMany: vi.fn(async (args) => {
        calls.updateMany.auditLog = (calls.updateMany.auditLog || []);
        calls.updateMany.auditLog.push(args);
        return { count: nulledAuditCount };
      }),
    },
  };
  return { client, calls };
}

describe("purgeOneIntakeInTx — ordered child delete", () => {
  it("deletes children before parent and nulls audit_log.intake_id", async () => {
    const { client, calls } = fakeIntakePrisma();
    const result = await purgeOneIntakeInTx({
      tx: client,
      intakeId: "intake-X",
      countyId: "county-A",
    });

    // Every child table got a deleteMany scoped to the intakeId.
    for (const model of [
      "conversationLog", "incomeSource", "householdMember",
      "deduction", "shelterExpense", "documentChecklist",
      "intakeReview", "applicant",
    ]) {
      expect(calls.deleteMany[model][0].where).toEqual({ intakeId: "intake-X" });
    }
    // AuditLog rows are UPDATED (intakeId set to null), not deleted.
    expect(calls.updateMany.auditLog[0]).toEqual({
      where: { intakeId: "intake-X" },
      data: { intakeId: null },
    });
    // Parent is deleted last.
    expect(calls.delete[0].where).toEqual({ id: "intake-X" });
    expect(result).toMatchObject({ intakeId: "intake-X", countyId: "county-A" });
  });
});

describe("runAbandonedIntakePolicy — config validation", () => {
  it("rejects retentionDays below the floor (30)", async () => {
    const { client } = fakeIntakePrisma();
    await expect(
      runAbandonedIntakePolicy({ prisma: client, retentionDays: 10, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("accepts exactly MIN_INTAKE_RETENTION_DAYS", async () => {
    const { client } = fakeIntakePrisma();
    await expect(
      runAbandonedIntakePolicy({
        prisma: client,
        retentionDays: MIN_INTAKE_RETENTION_DAYS,
        dryRun: true,
      })
    ).resolves.toMatchObject({ policy: "abandonedIntake" });
  });
});

describe("runAbandonedIntakePolicy — query shape", () => {
  it("filters status IN (ABANDONED, TIMED_OUT) only and excludes IN_PROGRESS", async () => {
    const { client, calls } = fakeIntakePrisma();
    await runAbandonedIntakePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: true,
    });
    const where = calls.findMany[0].where;
    expect(where.status).toEqual({ in: ["ABANDONED", "TIMED_OUT"] });
    // critical: IN_PROGRESS must NOT be in the list
    expect(where.status.in).not.toContain("IN_PROGRESS");
    // must require no caseworker + no reviews
    expect(where.caseworkerId).toBeNull();
    expect(where.reviews).toEqual({ none: {} });
  });

  it("selects id + countyId for per-intake audit evidence", async () => {
    const { client, calls } = fakeIntakePrisma();
    await runAbandonedIntakePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: true,
    });
    expect(calls.findMany[0].select).toEqual({ id: true, countyId: true });
  });
});

describe("runAbandonedIntakePolicy — dry-run and circuit breaker", () => {
  it("dry-run does not call intake.delete", async () => {
    const { client } = fakeIntakePrisma({
      candidates: [{ id: "a", countyId: "c" }, { id: "b", countyId: "c" }],
    });
    const result = await runAbandonedIntakePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: true,
    });
    expect(client.intake.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 2, deleted: 0, dryRun: true });
  });

  it("circuit breaker trips when candidates exceed maxRows", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `i-${i}`, countyId: "c" }));
    const { client } = fakeIntakePrisma({ candidates: many });
    await expect(
      runAbandonedIntakePolicy({
        prisma: client,
        clock: fixedClock("2026-04-21T00:00:00.000Z"),
        retentionDays: 90,
        maxRows: 5,
        dryRun: false,
      })
    ).rejects.toBeInstanceOf(RetentionCircuitBreakerError);
    expect(client.intake.delete).not.toHaveBeenCalled();
  });
});

describe("runAbandonedIntakePolicy — happy path", () => {
  it("deletes each candidate intake via purgeOneIntakeInTx and reports perIntake", async () => {
    const { client } = fakeIntakePrisma({
      candidates: [
        { id: "intake-1", countyId: "county-A" },
        { id: "intake-2", countyId: "county-B" },
      ],
    });
    const result = await runAbandonedIntakePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 90,
      dryRun: false,
    });
    expect(client.intake.delete).toHaveBeenCalledTimes(2);
    expect(result.deleted).toBe(2);
    expect(result.perIntake).toHaveLength(2);
    expect(result.perIntake[0].intakeId).toBe("intake-1");
    expect(result.perIntake[0].countyId).toBe("county-A");
    expect(result.perIntake[0].childCounts).toHaveProperty("auditLogsNulled");
  });
});

// ----------------------------------------------------------------------
// Caseworker soft-delete (purge) policy
// ----------------------------------------------------------------------

function fakeCaseworkerPrisma({ candidates = [] } = {}) {
  const calls = { findMany: [], update: [] };
  const client = {
    caseworker: {
      findMany: vi.fn(async (args) => {
        calls.findMany.push(args);
        const n = Math.min(candidates.length, args.take);
        return candidates.slice(0, n);
      }),
      update: vi.fn(async (args) => {
        calls.update.push(args);
        return { id: args.where.id };
      }),
    },
  };
  return { client, calls };
}

describe("runCaseworkerPurgePolicy — config validation", () => {
  it("rejects retentionDays below NIST IA-4 floor (730)", async () => {
    const { client } = fakeCaseworkerPrisma();
    await expect(
      runCaseworkerPurgePolicy({ prisma: client, retentionDays: 365, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("accepts exactly MIN_CASEWORKER_RETENTION_DAYS", async () => {
    const { client } = fakeCaseworkerPrisma();
    await expect(
      runCaseworkerPurgePolicy({
        prisma: client,
        retentionDays: MIN_CASEWORKER_RETENTION_DAYS,
        dryRun: true,
      })
    ).resolves.toMatchObject({ policy: "caseworkerPurge" });
  });
});

describe("runCaseworkerPurgePolicy — query shape", () => {
  it("filters deactivatedAt < cutoff AND purgedAt IS NULL (idempotent)", async () => {
    const { client, calls } = fakeCaseworkerPrisma();
    await runCaseworkerPurgePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 1095,
      dryRun: true,
    });
    const where = calls.findMany[0].where;
    expect(where.deactivatedAt).toEqual({ not: null, lt: expect.any(Date) });
    expect(where.purgedAt).toBeNull();
  });
});

describe("runCaseworkerPurgePolicy — dry-run and happy path", () => {
  it("dry-run does not call update", async () => {
    const { client } = fakeCaseworkerPrisma({
      candidates: [{ id: "c1", countyId: "x" }],
    });
    await runCaseworkerPurgePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 1095,
      dryRun: true,
    });
    expect(client.caseworker.update).not.toHaveBeenCalled();
  });

  it("overwrites name/email/password with tombstones and sets purgedAt", async () => {
    const { client, calls } = fakeCaseworkerPrisma({
      candidates: [{ id: "cw-123", countyId: "county-A" }],
    });
    const result = await runCaseworkerPurgePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 1095,
      dryRun: false,
    });
    const upd = calls.update[0];
    expect(upd.where).toEqual({ id: "cw-123" });
    expect(upd.data.name).toBe(CASEWORKER_NAME_TOMBSTONE);
    expect(upd.data.email).toBe(purgedEmailFor("cw-123"));
    // Tombstone is NOT bcrypt-shaped — bcrypt.compare returns false on it.
    expect(upd.data.password).toBe(CASEWORKER_PASSWORD_TOMBSTONE);
    expect(upd.data.password.startsWith("$2")).toBe(false);
    expect(upd.data.purgedAt).toBeInstanceOf(Date);
    expect(result.purged).toBe(1);
    expect(result.perCaseworker).toEqual([{ id: "cw-123", countyId: "county-A" }]);
  });

  it("uses per-row id in the tombstone email so @unique is preserved", async () => {
    const { client, calls } = fakeCaseworkerPrisma({
      candidates: [
        { id: "a", countyId: "x" },
        { id: "b", countyId: "x" },
      ],
    });
    await runCaseworkerPurgePolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 1095,
      dryRun: false,
    });
    expect(calls.update[0].data.email).toBe("purged-a@invalid.local");
    expect(calls.update[1].data.email).toBe("purged-b@invalid.local");
  });
});

// ----------------------------------------------------------------------
// Intake timeout state-transition policy
// ----------------------------------------------------------------------

function fakeTimeoutPrisma({ candidates = [], updatedCount } = {}) {
  const calls = { findMany: [], updateMany: [] };
  const client = {
    intake: {
      findMany: vi.fn(async (args) => {
        calls.findMany.push(args);
        const n = Math.min(candidates.length, args.take);
        return candidates.slice(0, n);
      }),
      updateMany: vi.fn(async (args) => {
        calls.updateMany.push(args);
        return { count: updatedCount ?? candidates.length };
      }),
    },
  };
  return { client, calls };
}

describe("runIntakeTimeoutPolicy — config validation", () => {
  it("rejects retentionDays below MIN_INTAKE_TIMEOUT_DAYS (1)", async () => {
    const { client } = fakeTimeoutPrisma();
    await expect(
      runIntakeTimeoutPolicy({ prisma: client, retentionDays: 0, dryRun: true })
    ).rejects.toBeInstanceOf(RetentionConfigError);
  });

  it("accepts exactly MIN_INTAKE_TIMEOUT_DAYS (1)", async () => {
    const { client } = fakeTimeoutPrisma();
    await expect(
      runIntakeTimeoutPolicy({
        prisma: client,
        retentionDays: MIN_INTAKE_TIMEOUT_DAYS,
        dryRun: true,
      })
    ).resolves.toMatchObject({ policy: "intakeTimeout" });
  });
});

describe("runIntakeTimeoutPolicy — query shape", () => {
  it("filters status=IN_PROGRESS AND updatedAt<cutoff AND no caseworker AND no reviews", async () => {
    const { client, calls } = fakeTimeoutPrisma();
    await runIntakeTimeoutPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 7,
      dryRun: true,
    });
    const where = calls.findMany[0].where;
    expect(where.status).toBe("IN_PROGRESS");
    expect(where.updatedAt).toEqual({ lt: expect.any(Date) });
    expect(where.caseworkerId).toBeNull();
    expect(where.reviews).toEqual({ none: {} });
    // 2026-04-21 minus 7 days = 2026-04-14
    expect(where.updatedAt.lt.toISOString().slice(0, 10)).toBe("2026-04-14");
  });
});

describe("runIntakeTimeoutPolicy — dry-run and happy path", () => {
  it("dry-run does not mutate", async () => {
    const { client } = fakeTimeoutPrisma({
      candidates: [{ id: "a", countyId: "c" }],
    });
    const result = await runIntakeTimeoutPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 7,
      dryRun: true,
    });
    expect(client.intake.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 1, transitioned: 0, dryRun: true });
  });

  it("transitions candidates from IN_PROGRESS to TIMED_OUT with a guard clause", async () => {
    const { client, calls } = fakeTimeoutPrisma({
      candidates: [{ id: "i1", countyId: "county-A" }, { id: "i2", countyId: "county-B" }],
      updatedCount: 2,
    });
    const result = await runIntakeTimeoutPolicy({
      prisma: client,
      clock: fixedClock("2026-04-21T00:00:00.000Z"),
      retentionDays: 7,
      dryRun: false,
    });
    expect(calls.updateMany[0]).toEqual({
      // Guard: re-check status on the update so a concurrent caseworker
      // action between find and update doesn't clobber a legitimate row.
      where: { id: { in: ["i1", "i2"] }, status: "IN_PROGRESS" },
      data: { status: "TIMED_OUT" },
    });
    expect(result).toMatchObject({
      policy: "intakeTimeout",
      candidates: 2,
      transitioned: 2,
      dryRun: false,
    });
    expect(result.perIntake).toEqual([
      { id: "i1", countyId: "county-A" },
      { id: "i2", countyId: "county-B" },
    ]);
  });

  it("circuit breaker trips when candidates exceed maxRows", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `i-${i}`, countyId: "c" }));
    const { client } = fakeTimeoutPrisma({ candidates: many });
    await expect(
      runIntakeTimeoutPolicy({
        prisma: client,
        clock: fixedClock("2026-04-21T00:00:00.000Z"),
        retentionDays: 7,
        maxRows: 10,
        dryRun: false,
      })
    ).rejects.toBeInstanceOf(RetentionCircuitBreakerError);
    expect(client.intake.updateMany).not.toHaveBeenCalled();
  });
});

describe("CASEWORKER_PASSWORD_TOMBSTONE — not bcrypt-comparable", () => {
  it("is not a bcrypt-shaped string", () => {
    // bcrypt strings start with "$2a$", "$2b$", or "$2y$". Ours must not.
    expect(/^\$2[aby]\$/.test(CASEWORKER_PASSWORD_TOMBSTONE)).toBe(false);
  });
});

describe("RetentionScheduler.start — gating", () => {
  const { RetentionScheduler } = require("../src/services/retentionScheduler");
  const originalEnabled = process.env.RETENTION_ENABLED;
  const originalLeader = process.env.RETENTION_SCHEDULER_LEADER;

  function fakeCron() {
    return {
      schedule: vi.fn(() => ({ stop: vi.fn() })),
      validate: vi.fn(() => true),
    };
  }

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.RETENTION_ENABLED;
    else process.env.RETENTION_ENABLED = originalEnabled;
    if (originalLeader === undefined) delete process.env.RETENTION_SCHEDULER_LEADER;
    else process.env.RETENTION_SCHEDULER_LEADER = originalLeader;
  });

  it("does not schedule when not the leader", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "false";
    process.env.RETENTION_ENABLED = "true";
    const cronSpy = fakeCron();
    const s = new RetentionScheduler({ prisma: {}, cron: cronSpy });
    s.start();
    expect(cronSpy.schedule).not.toHaveBeenCalled();
  });

  it("does not schedule when RETENTION_ENABLED=false", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "true";
    process.env.RETENTION_ENABLED = "false";
    const cronSpy = fakeCron();
    const s = new RetentionScheduler({ prisma: {}, cron: cronSpy });
    s.start();
    expect(cronSpy.schedule).not.toHaveBeenCalled();
  });

  it("schedules once when leader + enabled", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "true";
    process.env.RETENTION_ENABLED = "true";
    const cronSpy = fakeCron();
    const s = new RetentionScheduler({ prisma: {}, cron: cronSpy });
    s.start();
    expect(cronSpy.schedule).toHaveBeenCalledTimes(1);
    // Second start should no-op (already running).
    s.start();
    expect(cronSpy.schedule).toHaveBeenCalledTimes(1);
  });

  it("refuses to schedule on an invalid cron expression", () => {
    process.env.RETENTION_SCHEDULER_LEADER = "true";
    process.env.RETENTION_ENABLED = "true";
    process.env.RETENTION_CRON_EXPRESSION = "this is not a cron";
    const cronSpy = fakeCron();
    cronSpy.validate = vi.fn(() => false);
    const s = new RetentionScheduler({ prisma: {}, cron: cronSpy });
    s.start();
    expect(cronSpy.schedule).not.toHaveBeenCalled();
    delete process.env.RETENTION_CRON_EXPRESSION;
  });
});
