import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashPin, requireStaffPin } from "../src/middleware/kioskAuth";

function mockReqRes(body = {}) {
  const req = { body, ip: "10.0.0.1" };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("hashPin", () => {
  it("produces a bcrypt hash", async () => {
    const hash = await hashPin("1234");
    expect(hash).toMatch(/^\$2[aby]?\$/);
    expect(hash.length).toBeGreaterThan(50);
  });

  it("produces different hashes for same PIN (salted)", async () => {
    const hash1 = await hashPin("1234");
    const hash2 = await hashPin("1234");
    expect(hash1).not.toBe(hash2); // bcrypt uses random salt
  });
});

describe("requireStaffPin", () => {
  const originalEnv = {};

  beforeEach(() => {
    originalEnv.KIOSK_STAFF_PINS = process.env.KIOSK_STAFF_PINS;
    originalEnv.NODE_ENV = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.KIOSK_STAFF_PINS = originalEnv.KIOSK_STAFF_PINS;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  it("allows request with valid PIN", async () => {
    const pin = "9876";
    process.env.KIOSK_STAFF_PINS = await hashPin(pin);
    const { req, res, next } = mockReqRes({ staffPin: pin });

    await requireStaffPin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.staffPinUsed).toBeDefined();
    expect(req.staffPinUsed).toHaveLength(8);
  });

  it("rejects request with invalid PIN", async () => {
    process.env.KIOSK_STAFF_PINS = await hashPin("9876");
    const { req, res, next } = mockReqRes({ staffPin: "0000" });

    await requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects request with no PIN provided", async () => {
    process.env.KIOSK_STAFF_PINS = await hashPin("9876");
    const { req, res, next } = mockReqRes({});

    await requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("supports multiple PINs", async () => {
    const pins = ["1111", "2222", "3333"];
    const hashes = await Promise.all(pins.map(hashPin));
    process.env.KIOSK_STAFF_PINS = hashes.join(",");

    // Each PIN should work
    for (const pin of pins) {
      const { req, res, next } = mockReqRes({ staffPin: pin });
      await requireStaffPin(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it("allows all in development when no PINs configured", async () => {
    process.env.KIOSK_STAFF_PINS = "";
    process.env.NODE_ENV = "development";
    const { req, res, next } = mockReqRes({});

    await requireStaffPin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("blocks all in production when no PINs configured", async () => {
    process.env.KIOSK_STAFF_PINS = "";
    process.env.NODE_ENV = "production";
    const { req, res, next } = mockReqRes({});

    await requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
