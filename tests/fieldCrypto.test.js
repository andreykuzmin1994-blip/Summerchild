import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";

const {
  encrypt,
  decrypt,
  safeDecrypt,
  isEncrypted,
  SENTINEL_DECRYPT_FAILED,
} = require("../src/lib/fieldCrypto");

const INTAKE_A = "11111111-1111-4111-8111-111111111111";
const INTAKE_B = "22222222-2222-4222-8222-222222222222";

describe("fieldCrypto — AES-256-GCM with AAD", () => {
  describe("round-trip", () => {
    it("encrypts and decrypts ASCII plaintext", () => {
      const ct = encrypt("hello world", INTAKE_A);
      expect(decrypt(ct, INTAKE_A)).toBe("hello world");
    });

    it("round-trips empty string", () => {
      const ct = encrypt("", INTAKE_A);
      expect(decrypt(ct, INTAKE_A)).toBe("");
    });

    it("round-trips unicode (emoji + CJK)", () => {
      const pt = "Hello 👋 世界 — naïve café";
      expect(decrypt(encrypt(pt, INTAKE_A), INTAKE_A)).toBe(pt);
    });

    it("round-trips 10 KB plaintext", () => {
      const pt = "x".repeat(10 * 1024);
      expect(decrypt(encrypt(pt, INTAKE_A), INTAKE_A)).toBe(pt);
    });

    it("produces non-deterministic ciphertext (random IV per call)", () => {
      const a = encrypt("same plaintext", INTAKE_A);
      const b = encrypt("same plaintext", INTAKE_A);
      expect(a).not.toBe(b);
    });

    it("ciphertext matches the v1:iv:tag:ct shape", () => {
      const ct = encrypt("abc", INTAKE_A);
      expect(ct).toMatch(/^v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    });
  });

  describe("AAD binding (intakeId)", () => {
    it("decrypting with the wrong intakeId fails (auth-tag mismatch)", () => {
      const ct = encrypt("secret for A", INTAKE_A);
      expect(() => decrypt(ct, INTAKE_B)).toThrow();
    });

    it("safeDecrypt with wrong intakeId returns sentinel and invokes onFailure", () => {
      const ct = encrypt("secret for A", INTAKE_A);
      let captured = null;
      const result = safeDecrypt(ct, INTAKE_B, (info) => { captured = info; });
      expect(result).toBe(SENTINEL_DECRYPT_FAILED);
      expect(captured).not.toBeNull();
      expect(captured.intakeId).toBe(INTAKE_B);
    });

    it("encrypt throws without intakeId (AAD required)", () => {
      expect(() => encrypt("x", "")).toThrow(/intakeId/);
      expect(() => encrypt("x", null)).toThrow(/intakeId/);
    });
  });

  describe("legacy plaintext passthrough", () => {
    it("decrypt returns plaintext unchanged when input is not ciphertext-shaped", () => {
      expect(decrypt("hello world", INTAKE_A)).toBe("hello world");
      expect(decrypt("This is a long message.", INTAKE_A)).toBe("This is a long message.");
    });

    it("user text starting with 'v1:' still passes through (shape-strict guard)", () => {
      // A user literally typing "v1: this is my rent" must not be misdetected.
      expect(decrypt("v1: my rent is $850", INTAKE_A)).toBe("v1: my rent is $850");
    });

    it("isEncrypted is strict about the full 4-segment shape", () => {
      expect(isEncrypted("v1:")).toBe(false);
      expect(isEncrypted("v1:a:b")).toBe(false);
      expect(isEncrypted("v1:YWJj:YWJj:YWJj")).toBe(true);
      expect(isEncrypted("not encrypted")).toBe(false);
    });
  });

  describe("tamper detection", () => {
    it("flipping a char in the ciphertext segment throws", () => {
      const ct = encrypt("original", INTAKE_A);
      const parts = ct.split(":");
      // Flip the first char of the ct segment
      const flipped = parts.slice(0, 3).concat(
        (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1)
      ).join(":");
      expect(() => decrypt(flipped, INTAKE_A)).toThrow();
    });

    it("flipping a char in the auth tag throws", () => {
      const ct = encrypt("original", INTAKE_A);
      const parts = ct.split(":");
      const flipped = [parts[0], parts[1],
        (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1),
        parts[3]].join(":");
      expect(() => decrypt(flipped, INTAKE_A)).toThrow();
    });

    it("safeDecrypt on tampered ct returns sentinel + onFailure fires", () => {
      const ct = encrypt("original", INTAKE_A);
      const tampered = ct.slice(0, -2) + "AA";
      let info = null;
      const result = safeDecrypt(tampered, INTAKE_A, (i) => { info = i; });
      expect(result).toBe(SENTINEL_DECRYPT_FAILED);
      expect(info).not.toBeNull();
    });

    it("safeDecrypt never leaks raw ciphertext", () => {
      const ct = encrypt("a secret", INTAKE_A);
      const tampered = ct.slice(0, -2) + "AA";
      const result = safeDecrypt(tampered, INTAKE_A, () => {});
      expect(result).not.toContain(tampered);
      expect(result).not.toContain("v1:");
    });
  });

  describe("unknown key version", () => {
    it("throws on ciphertext with an unknown version", () => {
      // Build a syntactically-valid ciphertext string with version v99.
      const fakeCt = "v99:" + Buffer.alloc(12).toString("base64") +
        ":" + Buffer.alloc(16).toString("base64") +
        ":" + Buffer.from("x").toString("base64");
      expect(() => decrypt(fakeCt, INTAKE_A)).toThrow(/unknown key version/);
    });
  });

  describe("null/undefined handling", () => {
    it("encrypt returns null/undefined unchanged", () => {
      expect(encrypt(null, INTAKE_A)).toBe(null);
      expect(encrypt(undefined, INTAKE_A)).toBe(undefined);
    });

    it("decrypt returns null/undefined unchanged", () => {
      expect(decrypt(null, INTAKE_A)).toBe(null);
      expect(decrypt(undefined, INTAKE_A)).toBe(undefined);
    });
  });
});
