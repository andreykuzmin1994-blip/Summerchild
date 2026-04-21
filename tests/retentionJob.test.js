import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  runConversationLogPolicy,
  RetentionCircuitBreakerError,
  RetentionConfigError,
  MIN_RETENTION_DAYS,
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
   * Build a fake Prisma that simulates:
   *   - $queryRaw for NOW() and pg_try_advisory_xact_lock
   *   - $transaction(cb) calls cb with a tx client derived from the same fake
   *   - auditLog.create recorded
   *   - intake.findMany / conversationLog.deleteMany pass-through
   */
  function fakeTxPrisma({
    dbNowOffsetMs = 0,
    lockGranted = true,
    auditCreateThrows = false,
    eligibleIntakeIds = [],
  } = {}) {
    const auditRows = [];

    const makeClient = () => {
      const client = {
        $queryRaw: vi.fn(async (strings) => {
          // Tagged-template literal: strings.raw is the array.
          const sql = (strings.raw || strings).join(" ");
          if (sql.includes("pg_try_advisory_xact_lock")) {
            return [{ locked: lockGranted }];
          }
          if (sql.includes("NOW()")) {
            return [{ dbNow: new Date(Date.now() + dbNowOffsetMs) }];
          }
          throw new Error(`unexpected $queryRaw in fake: ${sql}`);
        }),
        auditLog: {
          create: vi.fn(async ({ data }) => {
            if (auditCreateThrows) throw new Error("simulated audit write failure");
            auditRows.push(data);
            return { id: `audit-${auditRows.length}`, ...data };
          }),
        },
        intake: {
          findMany: vi.fn(async (args) => {
            const n = Math.min(eligibleIntakeIds.length, args.take);
            return eligibleIntakeIds.slice(0, n).map((id) => ({ id }));
          }),
        },
        conversationLog: {
          deleteMany: vi.fn(async () => ({ count: eligibleIntakeIds.length })),
        },
      };
      return client;
    };

    const outer = makeClient();
    outer.$transaction = vi.fn(async (cb) => cb(outer));
    return { prisma: outer, auditRows };
  }

  it("returns {ran:false, reason:'disabled'} when enabled=false", async () => {
    const { prisma } = fakeTxPrisma();
    const result = await runOnce({
      prisma,
      config: { enabled: false, dryRun: true, maxRows: 100, conversationLogDays: 90 },
    });
    expect(result).toEqual({ ran: false, reason: "disabled" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to run when DB clock differs from app clock by > tolerance", async () => {
    // Push DB clock 5 minutes ahead of app clock.
    const { prisma, auditRows } = fakeTxPrisma({ dbNowOffsetMs: 5 * 60 * 1000 });
    const result = await runOnce({
      prisma,
      config: { enabled: true, dryRun: false, maxRows: 100, conversationLogDays: 90 },
    });
    expect(result).toEqual({ ran: false, reason: "clock_skew" });
    // It should have attempted to audit the refusal, but never entered the tx.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_CLOCK_SKEW_DETECTED");
  });

  it("no-ops when another replica already holds the advisory lock", async () => {
    const { prisma, auditRows } = fakeTxPrisma({ lockGranted: false });
    const result = await runOnce({
      prisma,
      config: { enabled: true, dryRun: false, maxRows: 100, conversationLogDays: 90 },
    });
    expect(result).toEqual({ ran: false, reason: "lock_unavailable" });
    // No delete attempted.
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_SKIPPED_LOCKED");
  });

  it("fails closed: if DATA_RETENTION_STARTED audit write throws, no deletions occur", async () => {
    const { prisma } = fakeTxPrisma({ auditCreateThrows: true, eligibleIntakeIds: ["a", "b"] });
    await expect(
      runOnce({
        prisma,
        config: { enabled: true, dryRun: false, maxRows: 100, conversationLogDays: 90 },
      })
    ).rejects.toThrow(/audit write failure/);
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("happy path emits STARTED, POLICY_EXECUTED, COMPLETED events", async () => {
    const { prisma, auditRows } = fakeTxPrisma({ eligibleIntakeIds: ["a", "b"] });
    const result = await runOnce({
      prisma,
      config: { enabled: true, dryRun: false, maxRows: 100, conversationLogDays: 90 },
    });
    expect(result.ran).toBe(true);
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain("DATA_RETENTION_STARTED");
    expect(types).toContain("DATA_RETENTION_POLICY_EXECUTED");
    expect(types).toContain("DATA_RETENTION_COMPLETED");
    // Per-policy row carries the dryRun flag and counts.
    const policyRow = auditRows.find((r) => r.eventType === "DATA_RETENTION_POLICY_EXECUTED");
    expect(policyRow.details).toMatchObject({
      policy: "conversationLog",
      candidateIntakes: 2,
      dryRun: false,
    });
    // Actor convention: ACTORS.SYSTEM + stable id.
    expect(policyRow.actorType).toBe("SYSTEM");
    expect(policyRow.actorId).toBe("system:retention-job@v1");
  });

  it("dry-run path records dryRun:true in the evidence row and does not delete", async () => {
    const { prisma, auditRows } = fakeTxPrisma({ eligibleIntakeIds: ["a"] });
    await runOnce({
      prisma,
      config: { enabled: true, dryRun: true, maxRows: 100, conversationLogDays: 90 },
    });
    expect(prisma.conversationLog.deleteMany).not.toHaveBeenCalled();
    const policyRow = auditRows.find((r) => r.eventType === "DATA_RETENTION_POLICY_EXECUTED");
    expect(policyRow.details.dryRun).toBe(true);
    expect(policyRow.details.candidateIntakes).toBe(1);
    expect(policyRow.details.deletedLogs).toBe(0);
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
