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
  it("produces a consistent SHA-256 hash", () => {
    const hash = hashPin("1234");
    expect(hash).toBe(hashPin("1234"));
    expect(hash).toHaveLength(64);
  });

  it("produces different hashes for different PINs", () => {
    expect(hashPin("1234")).not.toBe(hashPin("5678"));
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

  it("allows request with valid PIN", () => {
    const pin = "9876";
    process.env.KIOSK_STAFF_PINS = hashPin(pin);
    const { req, res, next } = mockReqRes({ staffPin: pin });

    requireStaffPin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.staffPinUsed).toBe(hashPin(pin).slice(0, 8));
  });

  it("rejects request with invalid PIN", () => {
    process.env.KIOSK_STAFF_PINS = hashPin("9876");
    const { req, res, next } = mockReqRes({ staffPin: "0000" });

    requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects request with no PIN provided", () => {
    process.env.KIOSK_STAFF_PINS = hashPin("9876");
    const { req, res, next } = mockReqRes({});

    requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("supports multiple PINs", () => {
    const pins = ["1111", "2222", "3333"];
    process.env.KIOSK_STAFF_PINS = pins.map(hashPin).join(",");

    // Each PIN should work
    for (const pin of pins) {
      const { req, res, next } = mockReqRes({ staffPin: pin });
      requireStaffPin(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it("allows all in development when no PINs configured", () => {
    process.env.KIOSK_STAFF_PINS = "";
    process.env.NODE_ENV = "development";
    const { req, res, next } = mockReqRes({});

    requireStaffPin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("blocks all in production when no PINs configured", () => {
    process.env.KIOSK_STAFF_PINS = "";
    process.env.NODE_ENV = "production";
    const { req, res, next } = mockReqRes({});

    requireStaffPin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
