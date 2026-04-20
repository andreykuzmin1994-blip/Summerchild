import { describe, it, expect, vi, beforeEach } from "vitest";

const { verifyAuditLogImmutability } = require("../src/services/auditLogger");

// Build a fake Prisma client with a controllable $executeRaw tagged-template
// handler. The function accepts an optional client for dependency injection.
function fakeClient(handler) {
  return {
    $executeRaw: (...args) => handler(...args),
  };
}

describe("verifyAuditLogImmutability", () => {
  let executeRaw;

  beforeEach(() => {
    executeRaw = vi.fn();
  });

  it("returns 'mutable' + SECURITY ALERT when DELETE is permitted", async () => {
    executeRaw.mockResolvedValue(0);
    const result = await verifyAuditLogImmutability(fakeClient(executeRaw));
    expect(result.status).toBe("mutable");
    expect(result.immutable).toBe(false);
  });

  it("returns 'immutable' on Postgres 42501 insufficient_privilege", async () => {
    const err = new Error("permission denied for table audit_logs");
    err.code = "42501";
    executeRaw.mockRejectedValue(err);
    const result = await verifyAuditLogImmutability(fakeClient(executeRaw));
    expect(result.status).toBe("immutable");
    expect(result.immutable).toBe(true);
  });

  it("recognizes permission-denied via error message even without SQLSTATE code", async () => {
    executeRaw.mockRejectedValue(new Error("permission denied for relation audit_logs"));
    const result = await verifyAuditLogImmutability(fakeClient(executeRaw));
    expect(result.status).toBe("immutable");
  });

  it("returns 'unknown' (NOT immutable) on non-permission errors", async () => {
    // This is the bug the fix addresses: connection timeouts must not be
    // silently interpreted as a successful immutability verification.
    executeRaw.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    const result = await verifyAuditLogImmutability(fakeClient(executeRaw));
    expect(result.status).toBe("unknown");
    expect(result.immutable).toBe(false);
  });

  it("returns 'unknown' when the table is missing (schema not migrated)", async () => {
    const err = new Error("relation \"audit_logs\" does not exist");
    err.code = "42P01";
    executeRaw.mockRejectedValue(err);
    const result = await verifyAuditLogImmutability(fakeClient(executeRaw));
    expect(result.status).toBe("unknown");
    expect(result.immutable).toBe(false);
  });

  it("passes the always-false WHERE parameter so a permissive DB still loses no data", async () => {
    executeRaw.mockResolvedValue(0);
    await verifyAuditLogImmutability(fakeClient(executeRaw));
    // Called once, with a tagged-template strings array + a single `false` value
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0];
    expect(Array.isArray(strings)).toBe(true);
    expect(values).toEqual([false]);
  });
});
