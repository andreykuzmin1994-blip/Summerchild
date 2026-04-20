import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock auditLogger so we don't hit Prisma.
vi.mock("../src/services/auditLogger", () => ({
  logAuditEvent: vi.fn(() => Promise.resolve()),
  EVENTS: { CSRF_BLOCKED: "CSRF_BLOCKED" },
  ACTORS: { SYSTEM: "SYSTEM" },
}));

const { csrfProtection, isAllowedOrigin } = require("../src/middleware/csrfProtection");

function makeReq({ method = "POST", headers = {}, path = "/x" } = {}) {
  return {
    method,
    path,
    ip: "127.0.0.1",
    get: (name) => headers[name.toLowerCase()] ?? headers[name],
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe("csrfProtection", () => {
  const ORIGINAL = process.env.CORS_ORIGIN;
  beforeEach(() => {
    process.env.CORS_ORIGIN = "https://app.county.gov";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = ORIGINAL;
  });

  describe("safe methods", () => {
    it("passes GET through unconditionally", () => {
      const req = makeReq({ method: "GET", headers: { origin: "https://evil.example" } });
      const next = vi.fn();
      csrfProtection(req, makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it("passes HEAD through", () => {
      const next = vi.fn();
      csrfProtection(makeReq({ method: "HEAD" }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe("state-changing methods", () => {
    it("allows POST with matching Origin", () => {
      const req = makeReq({ headers: { origin: "https://app.county.gov" } });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it("blocks POST with mismatched Origin", () => {
      const req = makeReq({ headers: { origin: "https://evil.example" } });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/CSRF/i);
    });

    it("blocks POST with literal 'null' Origin (sandboxed iframe)", () => {
      const req = makeReq({ headers: { origin: "null" } });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("blocks subdomain that only endsWith the allowed origin", () => {
      const req = makeReq({ headers: { origin: "https://evil.app.county.gov" } });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("blocks POST with no Origin and no Bearer header", () => {
      const req = makeReq({ headers: {} });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(res.statusCode).toBe(403);
    });

    it("allows POST with no Origin but Authorization: Bearer (API client)", () => {
      const req = makeReq({ headers: { authorization: "Bearer abc.def.ghi" } });
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it("supports CSV CORS_ORIGIN for future multi-origin configs", () => {
      process.env.CORS_ORIGIN = "https://a.gov, https://b.gov";
      const req = makeReq({ headers: { origin: "https://b.gov" } });
      const next = vi.fn();
      csrfProtection(req, makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it("blocks PUT and DELETE the same as POST", () => {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const req = makeReq({ method, headers: { origin: "https://evil.example" } });
        const res = makeRes();
        const next = vi.fn();
        csrfProtection(req, res, next);
        expect(next, `${method} should be blocked`).not.toHaveBeenCalled();
        expect(res.statusCode, `${method} should 403`).toBe(403);
      }
    });
  });

  describe("isAllowedOrigin", () => {
    it("returns false for empty / null", () => {
      expect(isAllowedOrigin("")).toBe(false);
      expect(isAllowedOrigin("null")).toBe(false);
      expect(isAllowedOrigin(undefined)).toBe(false);
    });

    it("returns true for exact match", () => {
      expect(isAllowedOrigin("https://app.county.gov")).toBe(true);
    });
  });
});
