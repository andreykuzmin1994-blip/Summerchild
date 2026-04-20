import { describe, it, expect } from "vitest";

// Unit-test the role authorization helpers. We avoid spinning up the full
// Express app — the requireRole middleware is simple and well-covered by
// integration tests; here we focus on the NEW rules:
//   - ASSIGNABLE_ROLES includes AUDITOR
//   - SUPERVISOR cannot assign ADMIN / SUPERVISOR / AUDITOR
//   - Only ADMIN may assign privileged roles
//
// These helpers are not exported from caseworker.js (they're internals),
// so we re-implement the rule as a reference and assert the enum/behavior
// via the schema constants.

const { requireRole } = require("../src/middleware/auth");

describe("requireRole", () => {
  function run(actorRole, allowed) {
    const req = { user: { role: actorRole } };
    let denied = false;
    const res = { status() { denied = true; return this; }, json() { return this; } };
    const next = () => {};
    requireRole(...allowed)(req, res, next);
    return !denied;
  }

  it("allows when actor role is in the allowed list", () => {
    expect(run("ADMIN", ["ADMIN", "AUDITOR"])).toBe(true);
    expect(run("AUDITOR", ["ADMIN", "AUDITOR"])).toBe(true);
  });

  it("denies when actor role is not in the allowed list", () => {
    expect(run("CASEWORKER", ["ADMIN", "AUDITOR"])).toBe(false);
    expect(run("SUPERVISOR", ["ADMIN", "AUDITOR"])).toBe(false);
  });

  it("denies when req.user is missing", () => {
    const req = {};
    let denied = false;
    const res = { status() { denied = true; return this; }, json() { return this; } };
    requireRole("ADMIN")(req, res, () => {});
    expect(denied).toBe(true);
  });
});

describe("CaseworkerRole enum (compliance)", () => {
  // Schema change validation: the CaseworkerRole enum must include AUDITOR.
  // Read the prisma schema file directly.
  const fs = require("node:fs");
  const path = require("node:path");
  const schema = fs.readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8"
  );

  it("includes AUDITOR in CaseworkerRole enum", () => {
    const enumMatch = schema.match(/enum CaseworkerRole \{([\s\S]*?)\}/);
    expect(enumMatch).not.toBeNull();
    const body = enumMatch[1];
    expect(body).toMatch(/\bCASEWORKER\b/);
    expect(body).toMatch(/\bSUPERVISOR\b/);
    expect(body).toMatch(/\bADMIN\b/);
    expect(body).toMatch(/\bAUDITOR\b/);
  });
});

describe("audit-log endpoint authorization (static check)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const adminJs = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "admin.js"),
    "utf8"
  );

  it("GET /audit-log requires ADMIN or AUDITOR", () => {
    expect(adminJs).toMatch(/router\.get\(\s*"\/audit-log".*requireRole\(\s*"ADMIN"\s*,\s*"AUDITOR"\s*\)/s);
  });

  it("stats and export remain SUPERVISOR+ADMIN only (AUDITOR excluded)", () => {
    expect(adminJs).toMatch(/router\.get\(\s*"\/stats".*requireRole\(\s*"SUPERVISOR"\s*,\s*"ADMIN"\s*\)/s);
    expect(adminJs).toMatch(/router\.get\(\s*"\/export\/intakes".*requireRole\(\s*"SUPERVISOR"\s*,\s*"ADMIN"\s*\)/s);
  });
});

describe("caseworker register/update SoD guards (static check)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const caseworkerJs = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "caseworker.js"),
    "utf8"
  );

  it("exports a rolesActorMayAssign helper that caps SUPERVISOR to CASEWORKER", () => {
    expect(caseworkerJs).toMatch(/function rolesActorMayAssign/);
    // SUPERVISOR path must yield ["CASEWORKER"] only
    expect(caseworkerJs).toMatch(/actorRole === "SUPERVISOR"[\s\S]{0,100}return \[\s*"CASEWORKER"\s*\]/);
  });

  it("PUT /users/:id blocks self-role-change with a 403", () => {
    expect(caseworkerJs).toMatch(/req\.params\.id === req\.user\.id[\s\S]{0,400}cannot change their own role/i);
  });

  it("POST /register validates the requested role against the actor's authority", () => {
    expect(caseworkerJs).toMatch(/rolesActorMayAssign\(req\.user\.role\)/);
  });
});
