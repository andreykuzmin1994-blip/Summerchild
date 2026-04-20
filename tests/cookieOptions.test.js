import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { buildAuthCookieOptions, isSecureCookieEnabled } = require("../src/lib/cookies");

describe("buildAuthCookieOptions", () => {
  const ORIGINAL = process.env.ALLOW_INSECURE_COOKIES;

  beforeEach(() => {
    delete process.env.ALLOW_INSECURE_COOKIES;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.ALLOW_INSECURE_COOKIES;
    } else {
      process.env.ALLOW_INSECURE_COOKIES = ORIGINAL;
    }
  });

  it("defaults to secure: true (NIST SC-8 fail-closed)", () => {
    const opts = buildAuthCookieOptions();
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/");
  });

  it("sets secure: false ONLY when ALLOW_INSECURE_COOKIES is exactly 'true'", () => {
    process.env.ALLOW_INSECURE_COOKIES = "true";
    expect(buildAuthCookieOptions().secure).toBe(false);
  });

  it("ignores truthy-but-not-'true' values (safe-by-default)", () => {
    process.env.ALLOW_INSECURE_COOKIES = "1";
    expect(buildAuthCookieOptions().secure).toBe(true);

    process.env.ALLOW_INSECURE_COOKIES = "yes";
    expect(buildAuthCookieOptions().secure).toBe(true);

    process.env.ALLOW_INSECURE_COOKIES = "TRUE";
    expect(buildAuthCookieOptions().secure).toBe(true);
  });

  it("accepts overrides but does not let caller drop sameSite", () => {
    const opts = buildAuthCookieOptions({ maxAge: 1000 });
    expect(opts.maxAge).toBe(1000);
    expect(opts.sameSite).toBe("strict");
  });

  it("exposes isSecureCookieEnabled helper", () => {
    expect(isSecureCookieEnabled()).toBe(true);
    process.env.ALLOW_INSECURE_COOKIES = "true";
    expect(isSecureCookieEnabled()).toBe(false);
  });
});
