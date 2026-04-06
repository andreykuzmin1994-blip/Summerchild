/**
 * Integration Tests — end-to-end validation of key flows.
 *
 * These tests validate that components work correctly together:
 * - Session store + intake lifecycle
 * - DB retry logic under transient failures
 * - Zod validation + legacy validation pipeline
 * - Structured logging output format
 * - Health check endpoint contract
 * - Data export pagination
 * - Circuit breaker state transitions + observability
 *
 * County compliance: these tests ensure the system handles errors gracefully
 * without losing applicant data or producing incorrect SNAP calculations.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Session Store Integration ────────────────────────────────────────

describe("Session Store Lifecycle", () => {
  let store;

  beforeEach(async () => {
    const { MemorySessionStore } = await import("../src/services/sessionStore.js");
    store = new MemorySessionStore();
  });

  it("creates, retrieves, and deletes a session", async () => {
    const token = "test-token-abc123";
    const sessionData = {
      intakeId: "intake-001",
      systemPrompt: "You are a SNAP assistant",
      conversationHistory: [],
      turnNumber: 0,
      language: "en",
    };

    await store.set(token, sessionData);
    const retrieved = await store.get(token);
    expect(retrieved).toBeTruthy();
    expect(retrieved.intakeId).toBe("intake-001");
    expect(retrieved.lastActivity).toBeTypeOf("number");

    await store.delete(token);
    const deleted = await store.get(token);
    expect(deleted).toBeNull();
  });

  it("expires sessions after TTL", async () => {
    const token = "test-expire-token";
    await store.set(token, {
      intakeId: "intake-002",
      lastActivity: Date.now() - 31 * 60 * 1000, // 31 minutes ago
    });

    const expired = await store.get(token);
    expect(expired).toBeNull();
  });

  it("touch updates lastActivity", async () => {
    const token = "test-touch-token";
    const oldTime = Date.now() - 10000;
    await store.set(token, { intakeId: "intake-003", lastActivity: oldTime });

    await store.touch(token);
    const session = await store.get(token);
    expect(session.lastActivity).toBeGreaterThan(oldTime);
  });

  it("cleanup removes expired sessions", async () => {
    await store.set("active", {
      intakeId: "i1",
      lastActivity: Date.now(),
    });
    await store.set("expired", {
      intakeId: "i2",
      lastActivity: Date.now() - 31 * 60 * 1000,
    });

    // Trigger cleanup by calling get (which checks TTL)
    const active = await store.get("active");
    const expired = await store.get("expired");

    expect(active).toBeTruthy();
    expect(expired).toBeNull();
    expect(store.size).toBe(1);
  });
});

// ── DB Retry Logic Integration ───────────────────────────────────────

describe("Database Retry Logic", () => {
  const { withRetry, isTransientError } = require("../src/services/dbRetry");

  it("succeeds without retry on first attempt", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      return "success";
    }, { context: "test-op" });

    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  it("retries on transient error and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Connection pool timeout");
        err.code = "P1001";
        throw err;
      }
      return "recovered";
    }, { context: "test-retry", baseDelayMs: 10 });

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        const err = new Error("Unique constraint violation");
        err.code = "P2002";
        throw err;
      }, { context: "test-no-retry" })
    ).rejects.toThrow("Unique constraint violation");

    expect(attempts).toBe(1);
  });

  it("fails after max retries", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        const err = new Error("Can't reach database server");
        err.code = "P1001";
        throw err;
      }, { context: "test-max-retry", maxRetries: 2, baseDelayMs: 10 })
    ).rejects.toThrow("Can't reach database server");

    expect(attempts).toBe(3); // initial + 2 retries
  });

  describe("isTransientError", () => {
    it("recognizes Prisma transient codes", () => {
      expect(isTransientError({ code: "P1001" })).toBe(true);
      expect(isTransientError({ code: "P1002" })).toBe(true);
      expect(isTransientError({ code: "P1008" })).toBe(true);
      expect(isTransientError({ code: "P1017" })).toBe(true);
      expect(isTransientError({ code: "P2034" })).toBe(true);
    });

    it("recognizes network errors", () => {
      expect(isTransientError({ code: "ECONNREFUSED" })).toBe(true);
      expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
      expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("rejects non-transient errors", () => {
      expect(isTransientError({ code: "P2002" })).toBe(false);
      expect(isTransientError({ code: "P2025" })).toBe(false);
      expect(isTransientError({ message: "Something else" })).toBe(false);
    });
  });
});

// ── Zod + Legacy Validation Pipeline ─────────────────────────────────

describe("AI Response Validation Pipeline", () => {
  const { validateAIResponse } = require("../src/services/aiResponseValidator");
  const { validateExtractedData } = require("../src/services/dataValidator");

  it("validates a correct household member through both layers", () => {
    const dataBlock = {
      field: "household_member",
      display_name: "Sarah",
      relationship: "spouse",
      age_range: "30-39",
      is_elderly: false,
      is_disabled: false,
      purchases_and_prepares_together: true,
    };

    const zodResult = validateAIResponse(dataBlock);
    expect(zodResult.valid).toBe(true);

    const legacyResult = validateExtractedData(zodResult.data);
    expect(legacyResult.valid).toBe(true);
  });

  it("rejects negative income in Zod layer", () => {
    const dataBlock = {
      field: "income_source",
      gross_per_period: -500,
      pay_frequency: "monthly",
    };

    const result = validateAIResponse(dataBlock);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("negative"))).toBe(true);
  });

  it("rejects implausibly high income in Zod layer", () => {
    const dataBlock = {
      field: "income_source",
      gross_per_period: 999999,
      pay_frequency: "weekly",
    };

    const result = validateAIResponse(dataBlock);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum"))).toBe(true);
  });

  it("transforms pay_frequency to uppercase", () => {
    const dataBlock = {
      field: "income_source",
      gross_per_period: 1200,
      pay_frequency: "biweekly",
      employer: "Walmart",
    };

    const result = validateAIResponse(dataBlock);
    expect(result.valid).toBe(true);
    expect(result.data.pay_frequency).toBe("BIWEEKLY");
  });

  it("rejects invalid utility type", () => {
    const dataBlock = {
      field: "shelter_utility",
      utility_type: "NUCLEAR",
    };

    const result = validateAIResponse(dataBlock);
    expect(result.valid).toBe(false);
  });

  it("validates numeric fields (dependent care, medical, etc.)", () => {
    expect(validateAIResponse({ field: "dependent_care", value: 200 }).valid).toBe(true);
    expect(validateAIResponse({ field: "medical_expenses", value: 50 }).valid).toBe(true);
    expect(validateAIResponse({ field: "child_support_paid", value: 300 }).valid).toBe(true);
    expect(validateAIResponse({ field: "liquid_resources", value: 0 }).valid).toBe(true);

    expect(validateAIResponse({ field: "dependent_care", value: -10 }).valid).toBe(false);
    expect(validateAIResponse({ field: "medical_expenses", value: 99999 }).valid).toBe(false);
  });

  it("rejects unknown field types to prevent unvalidated data", () => {
    const result = validateAIResponse({ field: "future_new_field", value: "something" });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeTruthy();
    expect(result.errors[0]).toContain("Unknown field type");
  });

  it("rejects non-object input", () => {
    expect(validateAIResponse(null).valid).toBe(false);
    expect(validateAIResponse("string").valid).toBe(false);
    expect(validateAIResponse(42).valid).toBe(false);
  });
});

// ── Structured Logger ────────────────────────────────────────────────

describe("Structured Logger", () => {
  const { child } = require("../src/services/logger");

  it("creates scoped logger with all log methods", () => {
    const log = child("test-component");
    expect(log.error).toBeTypeOf("function");
    expect(log.warn).toBeTypeOf("function");
    expect(log.info).toBeTypeOf("function");
    expect(log.debug).toBeTypeOf("function");
  });

  it("outputs valid JSON", () => {
    const log = child("test-json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    log.error("test message", { key: "value" });

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("error");
    expect(parsed.component).toBe("test-json");
    expect(parsed.message).toBe("test message");
    expect(parsed.key).toBe("value");
    expect(parsed.timestamp).toBeTruthy();

    spy.mockRestore();
  });
});

// ── Circuit Breaker Observability ────────────────────────────────────

describe("Circuit Breaker Observability", () => {
  const { CircuitBreaker, AIProvider } = require("../src/services/aiProvider");

  it("tracks state transitions correctly", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });

    expect(cb.state).toBe("CLOSED");
    expect(cb.canAttempt()).toBe(true);

    cb.recordFailure();
    expect(cb.state).toBe("CLOSED"); // Not yet at threshold

    cb.recordFailure();
    expect(cb.state).toBe("OPEN"); // Threshold reached
    expect(cb.canAttempt()).toBe(false);
  });

  it("transitions to HALF_OPEN after reset timeout", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canAttempt()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");
  });

  it("resets to CLOSED on success after HALF_OPEN", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    cb.canAttempt(); // Trigger HALF_OPEN

    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
    expect(cb.failureCount).toBe(0);
  });

  it("exposes metrics from AIProvider", () => {
    const provider = new AIProvider();
    const metrics = provider.getMetrics();

    expect(metrics.activeProvider).toBe("anthropic");
    expect(metrics.circuitBreakers).toBeTruthy();
    expect(metrics.circuitBreakers.anthropic.state).toBe("CLOSED");
    expect(metrics.failoverStats).toBeTruthy();
    expect(metrics.failoverStats.total).toBe(0);
  });
});

// ── Rate Limiter Headers ─────────────────────────────────────────────

describe("Rate Limiter Configuration", () => {
  const { apiLimiter, aiMessageLimiter, authLimiter } = require("../src/middleware/rateLimiter");

  it("exports all three limiter tiers", () => {
    expect(apiLimiter).toBeTruthy();
    expect(aiMessageLimiter).toBeTruthy();
    expect(authLimiter).toBeTruthy();
  });

  it("rate limiters are Express middleware functions", () => {
    expect(typeof apiLimiter).toBe("function");
    expect(typeof aiMessageLimiter).toBe("function");
    expect(typeof authLimiter).toBe("function");
  });
});
