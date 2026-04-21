import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

/**
 * Verifies that caseworker rows whose `purgedAt` is set are rejected by
 * every authentication path. This is the "AU-10/AU-11 fail-closed" side
 * of the soft-delete design — the retention job tombstones PII columns,
 * and the auth layer MUST treat such rows as non-existent.
 *
 * Uses require-cache injection (same pattern as tests/helpers/mockPrisma.js)
 * because vi.mock does not reliably intercept CJS require() in auth.js.
 */

const nodeRequire = createRequire(import.meta.url);
const prismaPath = nodeRequire.resolve("../src/lib/prisma");

function installPrismaMock(findUniqueImpl) {
  nodeRequire.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: {
      caseworker: { findUnique: findUniqueImpl },
    },
  };
}

function uninstallPrismaMock() {
  delete nodeRequire.cache[prismaPath];
}

// Clear the auth module from cache so it picks up the freshly-installed mock.
function freshAuth() {
  const authPath = nodeRequire.resolve("../src/middleware/auth");
  delete nodeRequire.cache[authPath];
  return nodeRequire("../src/middleware/auth");
}

describe("purgedAt gate — requireVerifiedAuth middleware", () => {
  let findUnique;
  let requireVerifiedAuth;
  let token;

  beforeEach(() => {
    findUnique = vi.fn();
    installPrismaMock(findUnique);
    requireVerifiedAuth = freshAuth().requireVerifiedAuth;

    const jwt = nodeRequire("jsonwebtoken");
    token = jwt.sign(
      { id: "cw-1", countyId: "county-A", role: "CASEWORKER", email: "x@y" },
      process.env.JWT_SECRET,
      { algorithm: "HS256", expiresIn: "1h" }
    );
  });

  afterEach(() => {
    uninstallPrismaMock();
    // Drop the cached auth module so the next test reloads with a fresh mock.
    delete nodeRequire.cache[nodeRequire.resolve("../src/middleware/auth")];
  });

  function makeReqRes() {
    return {
      req: { headers: { authorization: `Bearer ${token}` } },
      res: { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() },
      next: vi.fn(),
    };
  }

  it("selects purgedAt alongside deactivatedAt", async () => {
    findUnique.mockResolvedValueOnce({
      id: "cw-1", countyId: "county-A", role: "CASEWORKER",
      deactivatedAt: null, purgedAt: null,
    });
    const { req, res, next } = makeReqRes();
    await requireVerifiedAuth(req, res, next);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ purgedAt: true, deactivatedAt: true }),
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it("rejects a purged caseworker with 401 (AU-10/AU-11)", async () => {
    findUnique.mockResolvedValueOnce({
      id: "cw-1", countyId: "county-A", role: "CASEWORKER",
      deactivatedAt: null,
      purgedAt: new Date("2023-04-21T00:00:00.000Z"),
    });
    const { req, res, next } = makeReqRes();
    await requireVerifiedAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("also rejects a deactivated caseworker (regression check)", async () => {
    findUnique.mockResolvedValueOnce({
      id: "cw-1", countyId: "county-A", role: "CASEWORKER",
      deactivatedAt: new Date("2023-04-21T00:00:00.000Z"),
      purgedAt: null,
    });
    const { req, res, next } = makeReqRes();
    await requireVerifiedAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows an active caseworker", async () => {
    findUnique.mockResolvedValueOnce({
      id: "cw-1", countyId: "county-A", role: "CASEWORKER",
      deactivatedAt: null, purgedAt: null,
    });
    const { req, res, next } = makeReqRes();
    await requireVerifiedAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
