import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";

// Tests for NIST AC-7 / IA-5 account lockout.
//
// Coverage:
//  - Pure state-machine helpers in src/services/loginLockout.js
//  - Behavioral tests of the /login handler via require-cache mock injection
//    (same pattern as tests/helpers/mockPrisma.js — vi.mock doesn't reliably
//    intercept CJS require() in the route module)
//  - Static schema + evidence checks (parity with tests/roleSeparation.test.js)

const nodeRequire = createRequire(import.meta.url);
const fs = nodeRequire("node:fs");
const path = nodeRequire("node:path");

const {
  MAX_FAILED_LOGINS,
  LOCKOUT_DURATION_MS,
  isAccountLocked,
  hasExpiredLock,
  reachedLockThreshold,
  computeLockExpiry,
} = nodeRequire("../src/services/loginLockout");

// --- Pure helpers ----------------------------------------------------------

describe("loginLockout pure helpers", () => {
  it("defaults to 5 attempts × 30 min per backlog spec", () => {
    expect(MAX_FAILED_LOGINS).toBe(5);
    expect(LOCKOUT_DURATION_MS).toBe(30 * 60 * 1000);
  });

  it("isAccountLocked: null lockedUntil → false", () => {
    expect(isAccountLocked({ lockedUntil: null })).toBe(false);
    expect(isAccountLocked({})).toBe(false);
    expect(isAccountLocked(null)).toBe(false);
  });

  it("isAccountLocked: lockedUntil in the future → true", () => {
    const future = new Date(Date.now() + 60_000);
    expect(isAccountLocked({ lockedUntil: future })).toBe(true);
  });

  it("isAccountLocked: lockedUntil in the past → false (lock expired)", () => {
    const past = new Date(Date.now() - 60_000);
    expect(isAccountLocked({ lockedUntil: past })).toBe(false);
  });

  it("hasExpiredLock: true only when lockedUntil is set and in the past", () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    expect(hasExpiredLock({ lockedUntil: past })).toBe(true);
    expect(hasExpiredLock({ lockedUntil: future })).toBe(false);
    expect(hasExpiredLock({ lockedUntil: null })).toBe(false);
  });

  it("reachedLockThreshold: exactly at threshold and above", () => {
    expect(reachedLockThreshold(0)).toBe(false);
    expect(reachedLockThreshold(4)).toBe(false);
    expect(reachedLockThreshold(5)).toBe(true);
    expect(reachedLockThreshold(6)).toBe(true);
  });

  it("computeLockExpiry adds exactly LOCKOUT_DURATION_MS to now", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiry = computeLockExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(LOCKOUT_DURATION_MS);
  });
});

// --- Handler behavior via require-cache injection --------------------------

function applyPrismaUpdate(row, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) {
      row[k] = (row[k] ?? 0) + v.increment;
    } else {
      row[k] = v;
    }
  }
}

function setupMocks({ caseworker }) {
  const state = { caseworker: caseworker ? { ...caseworker } : null };
  const auditCalls = [];

  const prismaStub = {
    caseworker: {
      findUnique: vi.fn(async () =>
        state.caseworker ? { ...state.caseworker } : null
      ),
      update: vi.fn(async ({ where, data, select }) => {
        if (!state.caseworker || state.caseworker.id !== where.id) {
          throw new Error("Record not found");
        }
        applyPrismaUpdate(state.caseworker, data);
        if (select) {
          const picked = {};
          for (const k of Object.keys(select)) {
            if (Object.prototype.hasOwnProperty.call(select, k) && select[k]) {
              picked[k] = state.caseworker[k];
            }
          }
          return picked;
        }
        return { ...state.caseworker };
      }),
    },
  };

  // 1. Clear the caseworker route from cache so it re-imports with our stubs.
  const routePath = nodeRequire.resolve("../src/routes/caseworker");
  delete nodeRequire.cache[routePath];

  // 2. Load real auditLogger + auth, overlay our stubs, re-seat in cache.
  const auditPath = nodeRequire.resolve("../src/services/auditLogger");
  const realAudit = nodeRequire(auditPath);
  nodeRequire.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    children: [],
    exports: {
      ...realAudit,
      logAuditEvent: vi.fn(async (evt) => { auditCalls.push(evt); }),
    },
  };

  const authPath = nodeRequire.resolve("../src/middleware/auth");
  const realAuth = nodeRequire(authPath);
  nodeRequire.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    children: [],
    exports: {
      ...realAuth,
      comparePassword: vi.fn(async (plain, hash) => plain === `valid-for:${hash}`),
      generateToken: vi.fn(() => "test.jwt.token"),
    },
  };

  // 3. Inject @prisma/client stub so new PrismaClient() returns our stub.
  const prismaPath = nodeRequire.resolve("@prisma/client");
  nodeRequire.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    children: [],
    exports: { PrismaClient: function () { return prismaStub; } },
  };

  // 4. Now load the route fresh.
  const mod = nodeRequire(routePath);
  return { state, auditCalls, loginHandler: mod.loginHandler };
}

function mockReqRes(body = {}) {
  const req = { body, ip: "10.0.0.1" };
  const res = {
    statusCode: 200,
    headersSent: false,
    cookies: {},
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    cookie(name, value, opts) { this.cookies[name] = { value, opts }; return this; },
  };
  return { req, res };
}

function freshCaseworker(overrides = {}) {
  return {
    id: "cw-1",
    countyId: "c-1",
    email: "a@x.gov",
    name: "A",
    password: "HASH",
    role: "CASEWORKER",
    deactivatedAt: null,
    loginFailedCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

describe("POST /api/caseworker/login lockout behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bad password increments loginFailedCount + emits LOGIN_FAILED", async () => {
    const { state, auditCalls, loginHandler } = setupMocks({ caseworker: freshCaseworker() });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "wrong" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(state.caseworker.loginFailedCount).toBe(1);
    expect(state.caseworker.lockedUntil).toBeNull();
    const failed = auditCalls.find((e) => e.type === "CASEWORKER_LOGIN_FAILED");
    expect(failed).toBeDefined();
    expect(failed.details).toEqual({ attemptCount: 1 });
  });

  it("fifth bad password sets lockedUntil ~30 min out + emits ACCOUNT_LOCKED", async () => {
    const { state, auditCalls, loginHandler } = setupMocks({
      caseworker: freshCaseworker({ loginFailedCount: 4 }),
    });
    const before = Date.now();
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "wrong" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(state.caseworker.loginFailedCount).toBe(5);
    const lockMs = new Date(state.caseworker.lockedUntil).getTime();
    expect(lockMs - before).toBeGreaterThanOrEqual(LOCKOUT_DURATION_MS - 1000);
    expect(lockMs - before).toBeLessThanOrEqual(LOCKOUT_DURATION_MS + 1000);
    expect(auditCalls.map((e) => e.type)).toContain("CASEWORKER_ACCOUNT_LOCKED");
  });

  it("NEGATIVE: correct password is REJECTED while locked (proves AC-7)", async () => {
    const { state, auditCalls, loginHandler } = setupMocks({
      caseworker: freshCaseworker({
        loginFailedCount: 5,
        lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      }),
    });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "valid-for:HASH" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
    expect(res.cookies.token).toBeUndefined();
    expect(auditCalls.map((e) => e.type)).not.toContain("CASEWORKER_LOGIN");
    expect(state.caseworker.loginFailedCount).toBe(5);
  });

  it("expired lock + correct password → 200 + counter/lock reset", async () => {
    const { state, loginHandler } = setupMocks({
      caseworker: freshCaseworker({
        loginFailedCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
      }),
    });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "valid-for:HASH" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBe("test.jwt.token");
    expect(state.caseworker.loginFailedCount).toBe(0);
    expect(state.caseworker.lockedUntil).toBeNull();
  });

  it("expired lock + bad password → counter resets to 1 (fresh window)", async () => {
    const { state, loginHandler } = setupMocks({
      caseworker: freshCaseworker({
        loginFailedCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
      }),
    });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "wrong" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(state.caseworker.loginFailedCount).toBe(1);
    expect(state.caseworker.lockedUntil).toBeNull();
  });

  it("successful login with existing failures resets counter to 0", async () => {
    const { state, loginHandler } = setupMocks({
      caseworker: freshCaseworker({ loginFailedCount: 3 }),
    });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "valid-for:HASH" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(state.caseworker.loginFailedCount).toBe(0);
  });

  it("off-by-one guard: 4 bad attempts does NOT lock", async () => {
    const { state, loginHandler } = setupMocks({ caseworker: freshCaseworker() });
    for (let i = 0; i < 4; i++) {
      const { req, res } = mockReqRes({ email: "a@x.gov", password: "wrong" });
      await loginHandler(req, res);
    }
    expect(state.caseworker.loginFailedCount).toBe(4);
    expect(state.caseworker.lockedUntil).toBeNull();
  });

  it("deactivated user: no counter increment (no DB-write amplification)", async () => {
    const { state, loginHandler } = setupMocks({
      caseworker: freshCaseworker({ deactivatedAt: new Date() }),
    });
    const { req, res } = mockReqRes({ email: "a@x.gov", password: "wrong" });

    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(state.caseworker.loginFailedCount).toBe(0);
  });

  it("enumeration defense: locked+correct-pw response shape == bad-pw response shape", async () => {
    const lockedCtx = setupMocks({
      caseworker: freshCaseworker({
        loginFailedCount: 5,
        lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      }),
    });
    const r1 = mockReqRes({ email: "a@x.gov", password: "valid-for:HASH" });
    await lockedCtx.loginHandler(r1.req, r1.res);

    const badPwCtx = setupMocks({ caseworker: freshCaseworker() });
    const r2 = mockReqRes({ email: "a@x.gov", password: "wrong" });
    await badPwCtx.loginHandler(r2.req, r2.res);

    expect(r1.res.statusCode).toBe(r2.res.statusCode);
    expect(r1.res.body).toEqual(r2.res.body);
  });
});

// --- Static/schema checks (style parity with tests/roleSeparation.test.js) --

describe("schema + evidence checks for AC-7 lockout", () => {
  const schema = fs.readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8"
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "caseworker.js"),
    "utf8"
  );
  const auditLogger = fs.readFileSync(
    path.join(process.cwd(), "src", "services", "auditLogger.js"),
    "utf8"
  );

  it("Caseworker model has loginFailedCount and lockedUntil", () => {
    expect(schema).toMatch(/loginFailedCount\s+Int\s+@default\(0\)\s+@map\("login_failed_count"\)/);
    expect(schema).toMatch(/lockedUntil\s+DateTime\?\s+@map\("locked_until"\)/);
  });

  it("login route imports lockout helpers", () => {
    expect(route).toMatch(/require\("\.\.\/services\/loginLockout"\)/);
    expect(route).toMatch(/isAccountLocked/);
    expect(route).toMatch(/reachedLockThreshold/);
  });

  it("login route runs bcrypt compare before the lock-gate return (timing parity)", () => {
    const compareIdx = route.indexOf("await comparePassword(password, caseworker.password)");
    const lockGateIdx = route.indexOf("if (locked) {");
    expect(compareIdx).toBeGreaterThan(-1);
    expect(lockGateIdx).toBeGreaterThan(-1);
    expect(compareIdx).toBeLessThan(lockGateIdx);
  });

  it("admin password reset clears loginFailedCount and lockedUntil", () => {
    const resetAnchor = route.indexOf("/users/:id/reset-password");
    expect(resetAnchor).toBeGreaterThan(-1);
    const resetBlock = route.slice(resetAnchor, resetAnchor + 2000);
    expect(resetBlock).toMatch(/loginFailedCount:\s*0/);
    expect(resetBlock).toMatch(/lockedUntil:\s*null/);
  });

  it("auditLogger exposes LOGIN_FAILED and ACCOUNT_LOCKED event types", () => {
    expect(auditLogger).toMatch(/CASEWORKER_LOGIN_FAILED:\s*"CASEWORKER_LOGIN_FAILED"/);
    expect(auditLogger).toMatch(/CASEWORKER_ACCOUNT_LOCKED:\s*"CASEWORKER_ACCOUNT_LOCKED"/);
  });
});
