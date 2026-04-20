import { describe, it, expect } from "vitest";

// Exercise the staffPinLimiter's keyGenerator + skip logic directly by
// constructing a minimal request-shaped object. We don't try to hit
// express-rate-limit's full behavior in a unit test — the value is in
// verifying our key derivation.

const { staffPinLimiter } = require("../src/middleware/rateLimiter");

describe("staffPinLimiter config", () => {
  it("exposes a rate-limit middleware function", () => {
    expect(typeof staffPinLimiter).toBe("function");
  });
});

describe("kioskAuth staffPinUsed key", () => {
  // Verify the derived key is 8 chars of ACTUAL salt entropy, not the
  // fixed `$2a$12$` bcrypt prefix. Collision resistance requires this.
  const { requireStaffPin } = require("../src/middleware/kioskAuth");
  const bcrypt = require("bcryptjs");

  it("sets req.staffPinUsed from the salt, not the fixed $2a$12$ prefix", async () => {
    const hash = await bcrypt.hash("1234", 10); // lower rounds for test speed
    const originalEnv = process.env.KIOSK_STAFF_PINS;
    process.env.KIOSK_STAFF_PINS = hash;
    try {
      const req = { body: { staffPin: "1234" }, ip: "127.0.0.1" };
      const res = {};
      let called = false;
      await requireStaffPin(req, res, () => { called = true; });
      expect(called).toBe(true);
      expect(req.staffPinUsed).toBeDefined();
      expect(req.staffPinUsed).toHaveLength(8);
      // The fixed bcrypt prefix is the first 7 chars ($2a$12$ or $2b$10$ etc.)
      // — ensure our key doesn't just echo that prefix.
      expect(req.staffPinUsed.startsWith("$")).toBe(false);
    } finally {
      if (originalEnv === undefined) delete process.env.KIOSK_STAFF_PINS;
      else process.env.KIOSK_STAFF_PINS = originalEnv;
    }
  });

  it("derives distinct keys for different PINs (no collision on prefix)", async () => {
    const hashA = await bcrypt.hash("1111", 10);
    const hashB = await bcrypt.hash("2222", 10);
    const originalEnv = process.env.KIOSK_STAFF_PINS;
    process.env.KIOSK_STAFF_PINS = `${hashA},${hashB}`;
    try {
      const keys = new Set();
      for (const pin of ["1111", "2222"]) {
        const req = { body: { staffPin: pin }, ip: "127.0.0.1" };
        await requireStaffPin(req, {}, () => {});
        keys.add(req.staffPinUsed);
      }
      expect(keys.size).toBe(2);
    } finally {
      if (originalEnv === undefined) delete process.env.KIOSK_STAFF_PINS;
      else process.env.KIOSK_STAFF_PINS = originalEnv;
    }
  });
});
