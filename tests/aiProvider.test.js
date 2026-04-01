import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker, AIProvider } from "../src/services/aiProvider";

describe("CircuitBreaker", () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
  });

  it("starts in CLOSED state allowing attempts", () => {
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe("CLOSED");
  });

  it("stays CLOSED after fewer failures than threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe("CLOSED");
  });

  it("opens after reaching failure threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("resets failure count on success", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.state).toBe("CLOSED");
  });

  it("transitions to HALF_OPEN after reset timeout", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe("HALF_OPEN");
  });

  it("returns to CLOSED from HALF_OPEN on success", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    breaker.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    breaker.canAttempt(); // triggers HALF_OPEN
    breaker.recordSuccess();
    expect(breaker.state).toBe("CLOSED");
  });
});

describe("AIProvider", () => {
  it("reports no fallback when OPENAI_API_KEY is not set", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const provider = new AIProvider();
    expect(provider.hasFallback()).toBe(false);
    process.env.OPENAI_API_KEY = original;
  });

  it("identifies failover-worthy errors correctly", () => {
    const provider = new AIProvider();

    // Should failover — service errors
    expect(provider._isFailoverError({ status: 529 })).toBe(true);
    expect(provider._isFailoverError({ status: 503 })).toBe(true);
    expect(provider._isFailoverError({ status: 502 })).toBe(true);
    expect(provider._isFailoverError({ status: 500 })).toBe(true);
    expect(provider._isFailoverError({ code: "ETIMEDOUT" })).toBe(true);
    expect(provider._isFailoverError({ code: "ECONNREFUSED" })).toBe(true);
    expect(provider._isFailoverError({ message: "request timeout" })).toBe(true);

    // Should failover — auth errors (key revoked/expired mid-session,
    // applicant at kiosk can't fix this)
    expect(provider._isFailoverError({ status: 401 })).toBe(true);
    expect(provider._isFailoverError({ status: 403 })).toBe(true);

    // Should NOT failover
    expect(provider._isFailoverError({ status: 400 })).toBe(false); // code bug
    expect(provider._isFailoverError({ status: 429 })).toBe(false); // rate limit, temporary
  });

  it("logs failover events", () => {
    const provider = new AIProvider();
    provider._logFailover("anthropic", "openai", { message: "Service unavailable", status: 503 });

    const log = provider.getFailoverLog();
    expect(log).toHaveLength(1);
    expect(log[0].from).toBe("anthropic");
    expect(log[0].to).toBe("openai");
    expect(log[0].reason).toBe("Service unavailable");
    expect(log[0].errorStatus).toBe(503);
  });

  it("caps failover log at 50 entries", () => {
    const provider = new AIProvider();
    for (let i = 0; i < 60; i++) {
      provider._logFailover("anthropic", "openai", { message: `Error ${i}` });
    }
    expect(provider.getFailoverLog()).toHaveLength(50);
  });

  it("throws descriptive error when no providers are available", async () => {
    const original = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const provider = new AIProvider();
    await expect(
      provider.sendMessage("test prompt", [{ role: "user", content: "hi" }], "HAIKU")
    ).rejects.toThrow("no fallback provider is configured");

    process.env.ANTHROPIC_API_KEY = original.anthropic;
    process.env.OPENAI_API_KEY = original.openai;
  });
});
