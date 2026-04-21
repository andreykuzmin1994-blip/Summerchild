import { describe, it, expect } from "vitest";

/**
 * Tests for the v2 field encryption API in `src/lib/fieldCrypto.js`.
 *
 * v2 binds ciphertext to { table, column, countyId, rowId } via a
 * richer AAD and derives a per-column subkey via HKDF. These tests
 * exercise the correctness guarantees: AAD binding, HKDF determinism,
 * back-compat with v1, context validation, sentinel fallback.
 *
 * v1 semantics (ConversationLog.content) are covered in tests/fieldCrypto.test.js.
 */

const {
  encrypt,
  decrypt,
  safeDecrypt,
  encryptV1,
  decryptV1,
  isEncrypted,
  SENTINEL_DECRYPT_FAILED,
  V2_FORMAT_TAG,
} = require("../src/lib/fieldCrypto");

const CTX_APPLICANT_A = {
  table: "applicants",
  column: "display_name",
  countyId: "county-A",
  rowId: "applicant-AAA",
};
const CTX_APPLICANT_A_OTHER_ROW = { ...CTX_APPLICANT_A, rowId: "applicant-BBB" };
const CTX_APPLICANT_A_OTHER_COL = { ...CTX_APPLICANT_A, column: "notes" };
const CTX_APPLICANT_A_OTHER_COUNTY = { ...CTX_APPLICANT_A, countyId: "county-B" };
const CTX_REVIEW = {
  table: "intake_reviews",
  column: "notes",
  countyId: "county-A",
  rowId: "review-xyz",
};

describe("fieldCrypto v2 — round trip", () => {
  it("encrypts and decrypts ASCII plaintext", () => {
    const ct = encrypt("Maria G.", CTX_APPLICANT_A);
    expect(decrypt(ct, CTX_APPLICANT_A)).toBe("Maria G.");
  });

  it("produces the v2.<keyVersion>:iv:tag:ct wire format", () => {
    const ct = encrypt("Maria G.", CTX_APPLICANT_A);
    expect(ct).toMatch(new RegExp(`^${V2_FORMAT_TAG}\\.v\\d+:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$`));
    expect(isEncrypted(ct)).toBe(true);
  });

  it("round-trips unicode", () => {
    const pt = "María Gónzalez — 日本語 🌮";
    expect(decrypt(encrypt(pt, CTX_APPLICANT_A), CTX_APPLICANT_A)).toBe(pt);
  });

  it("round-trips empty string", () => {
    expect(decrypt(encrypt("", CTX_APPLICANT_A), CTX_APPLICANT_A)).toBe("");
  });

  it("produces non-deterministic ciphertext (random IV) with deterministic subkey", () => {
    const a = encrypt("same plaintext", CTX_APPLICANT_A);
    const b = encrypt("same plaintext", CTX_APPLICANT_A);
    expect(a).not.toBe(b);
    // …but both decrypt to the same value under the same ctx.
    expect(decrypt(a, CTX_APPLICANT_A)).toBe("same plaintext");
    expect(decrypt(b, CTX_APPLICANT_A)).toBe("same plaintext");
  });
});

describe("fieldCrypto v2 — AAD binding", () => {
  it("same table/column, different rowId: decrypt fails", () => {
    const ct = encrypt("secret for applicant A", CTX_APPLICANT_A);
    expect(() => decrypt(ct, CTX_APPLICANT_A_OTHER_ROW)).toThrow();
  });

  it("same table/rowId, different column: decrypt fails (HKDF + AAD both change)", () => {
    const ct = encrypt("a name", CTX_APPLICANT_A);
    expect(() => decrypt(ct, CTX_APPLICANT_A_OTHER_COL)).toThrow();
  });

  it("same row, different countyId: decrypt fails (cross-tenant swap blocked)", () => {
    const ct = encrypt("a name", CTX_APPLICANT_A);
    expect(() => decrypt(ct, CTX_APPLICANT_A_OTHER_COUNTY)).toThrow();
  });

  it("different table entirely: decrypt fails", () => {
    const ct = encrypt("a name", CTX_APPLICANT_A);
    expect(() => decrypt(ct, { ...CTX_REVIEW, rowId: CTX_APPLICANT_A.rowId })).toThrow();
  });

  it("safeDecrypt with wrong rowId returns sentinel and invokes onFailure with ctx", () => {
    const ct = encrypt("Maria G.", CTX_APPLICANT_A);
    let captured = null;
    const result = safeDecrypt(ct, CTX_APPLICANT_A_OTHER_ROW, (info) => { captured = info; });
    expect(result).toBe(SENTINEL_DECRYPT_FAILED);
    expect(captured.ctx.rowId).toBe("applicant-BBB");
    expect(captured.ctx.table).toBe("applicants");
  });
});

describe("fieldCrypto v2 — context validation", () => {
  it("rejects missing ctx entirely", () => {
    expect(() => encrypt("x")).toThrow(/context/);
    expect(() => encrypt("x", null)).toThrow(/context/);
  });

  it("rejects individual missing fields", () => {
    const bad = { table: "t", column: "c", rowId: "r" }; // missing countyId
    expect(() => encrypt("x", bad)).toThrow(/countyId/);
  });

  it("rejects empty-string fields", () => {
    expect(() => encrypt("x", { ...CTX_APPLICANT_A, rowId: "" })).toThrow(/rowId/);
  });

  it("rejects fields containing the delimiter '|'", () => {
    expect(() => encrypt("x", { ...CTX_APPLICANT_A, countyId: "a|b" })).toThrow(/'\|'/);
    expect(() => encrypt("x", { ...CTX_APPLICANT_A, table: "a|b" })).toThrow(/'\|'/);
  });

  it("decrypt requires ctx the same as encrypt (no fall-through)", () => {
    const ct = encrypt("x", CTX_APPLICANT_A);
    expect(() => decrypt(ct, null)).toThrow(/context/);
    expect(() => decrypt(ct, { ...CTX_APPLICANT_A, rowId: "" })).toThrow(/rowId/);
  });
});

describe("fieldCrypto v2 — v1 interoperability", () => {
  it("v2 decrypt on v1 ciphertext throws with a helpful message", () => {
    const v1Ct = encryptV1("hello", "11111111-1111-4111-8111-111111111111");
    expect(() => decrypt(v1Ct, CTX_APPLICANT_A)).toThrow(/v1 ciphertext/);
  });

  it("v1 decrypt on v2 ciphertext throws with a helpful message", () => {
    const v2Ct = encrypt("hello", CTX_APPLICANT_A);
    expect(() => decryptV1(v2Ct, "any-intake-id")).toThrow(/v2 ciphertext/);
  });

  it("legacy plaintext passthrough works in both APIs", () => {
    expect(decrypt("plain", CTX_APPLICANT_A)).toBe("plain");
    expect(decryptV1("plain", "11111111-1111-4111-8111-111111111111")).toBe("plain");
  });

  it("isEncrypted matches both v1 and v2 shapes strictly", () => {
    const v1 = encryptV1("x", "11111111-1111-4111-8111-111111111111");
    const v2 = encrypt("x", CTX_APPLICANT_A);
    expect(isEncrypted(v1)).toBe(true);
    expect(isEncrypted(v2)).toBe(true);
    // Non-ciphertext strings
    expect(isEncrypted("v2.v1: my notes start with a version tag")).toBe(false);
    expect(isEncrypted("v1: plain text")).toBe(false);
  });
});

describe("fieldCrypto v2 — HKDF subkey properties", () => {
  it("different columns in the same table produce distinguishable ciphertext sets", () => {
    const ctA = encrypt("same", { ...CTX_APPLICANT_A, column: "col1" });
    const ctB = encrypt("same", { ...CTX_APPLICANT_A, column: "col2" });
    // Ciphertext bodies should differ (different subkey + different AAD).
    const bodyA = ctA.split(":").slice(1).join(":");
    const bodyB = ctB.split(":").slice(1).join(":");
    expect(bodyA).not.toBe(bodyB);
    // And decrypting A under column=col2 must fail.
    expect(() => decrypt(ctA, { ...CTX_APPLICANT_A, column: "col2" })).toThrow();
  });

  it("same ctx across many calls stays decryptable (subkey cache is stable)", () => {
    for (let i = 0; i < 20; i++) {
      const ct = encrypt(`turn ${i}`, CTX_APPLICANT_A);
      expect(decrypt(ct, CTX_APPLICANT_A)).toBe(`turn ${i}`);
    }
  });
});

describe("fieldCrypto v2 — null/undefined handling", () => {
  it("encrypt passes through null/undefined", () => {
    expect(encrypt(null, CTX_APPLICANT_A)).toBeNull();
    expect(encrypt(undefined, CTX_APPLICANT_A)).toBeUndefined();
  });

  it("decrypt passes through null/undefined", () => {
    expect(decrypt(null, CTX_APPLICANT_A)).toBeNull();
    expect(decrypt(undefined, CTX_APPLICANT_A)).toBeUndefined();
  });

  it("safeDecrypt passes through null/undefined without invoking onFailure", () => {
    let called = false;
    expect(safeDecrypt(null, CTX_APPLICANT_A, () => { called = true; })).toBeNull();
    expect(called).toBe(false);
  });
});
