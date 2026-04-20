import { describe, it, expect } from "vitest";

const { validateJwtSecret } = require("../src/middleware/auth");

// openssl rand -base64 32 style output (44 chars, upper+lower+digit+possibly symbol)
const STRONG_BASE64 = "Hq3wZg7T6oYbN2pKvE1sLcM9fXrJaU8yBdVhQzMkRuI=";
// openssl rand -hex 32 style output (64 chars, lower+digit only — must be accepted)
const STRONG_HEX = "0f3b8c2d4e6a1f9b7c5d2e8a4f1b6c9d3e7a2f8b5c1d9e6a4f2b8c7d3e1a9f5b";

describe("validateJwtSecret", () => {
  describe("accepts strong secrets", () => {
    it("accepts a base64 secret from openssl rand -base64 32", () => {
      expect(() => validateJwtSecret(STRONG_BASE64)).not.toThrow();
    });

    it("accepts a hex secret from openssl rand -hex 32 (only 2 char classes)", () => {
      expect(() => validateJwtSecret(STRONG_HEX)).not.toThrow();
    });

    it("accepts a mixed 32-char passphrase with 3 character classes", () => {
      expect(() => validateJwtSecret("Correct-Horse-Battery-Staple-2026!")).not.toThrow();
    });
  });

  describe("rejects missing or empty", () => {
    it("rejects null", () => {
      expect(() => validateJwtSecret(null)).toThrow(/required/i);
    });

    it("rejects undefined", () => {
      expect(() => validateJwtSecret(undefined)).toThrow(/required/i);
    });

    it("rejects empty string", () => {
      expect(() => validateJwtSecret("")).toThrow(/required/i);
    });

    it("rejects whitespace-only", () => {
      expect(() => validateJwtSecret("   \t\n   ")).toThrow(/required/i);
    });
  });

  describe("rejects short secrets", () => {
    it("rejects a 31-char otherwise-strong secret (boundary)", () => {
      expect(() => validateJwtSecret("Ab1!Ab1!Ab1!Ab1!Ab1!Ab1!Ab1!Ab1")).toThrow(/32 characters/i);
    });

    it("rejects a 10-char secret", () => {
      expect(() => validateJwtSecret("Ab1!Cd2@Ef")).toThrow(/32 characters/i);
    });
  });

  describe("rejects placeholders", () => {
    it("rejects the .env.example default 'your-secret-here' padded to length", () => {
      expect(() => validateJwtSecret("your-secret-here-your-secret-here")).toThrow(/placeholder/i);
    });

    it("rejects 'change-me' padded to length", () => {
      expect(() => validateJwtSecret("change-me-change-me-change-me-change-me")).toThrow(/placeholder/i);
    });

    it("rejects 'test-secret-for-ci-only' padded to length", () => {
      expect(() => validateJwtSecret("test-secret-for-ci-only-test-secret-for-ci-only")).toThrow(/placeholder/i);
    });

    it("matches case-insensitively (CHANGEME)", () => {
      expect(() => validateJwtSecret("CHANGEME-CHANGEME-CHANGEME-CHANGEME")).toThrow(/placeholder/i);
    });
  });

  describe("rejects trivial patterns", () => {
    it("rejects 40 repeated 'x'", () => {
      expect(() => validateJwtSecret("x".repeat(40))).toThrow(/repeated single character/i);
    });

    it("rejects 32 repeated digits", () => {
      expect(() => validateJwtSecret("1".repeat(32))).toThrow(/repeated single character/i);
    });
  });

  describe("rejects low character diversity", () => {
    it("rejects 32 lowercase + 32 lowercase (2 classes, non-hex)", () => {
      // lowercase letters only, not hex-chars — falls through to diversity check
      const lowOnly = "ghijklmnopqrstuvwxyzghijklmnopqr"; // 32 chars, lowercase, not hex-alphabet
      expect(() => validateJwtSecret(lowOnly)).toThrow(/diversity/i);
    });
  });

  describe("error messages never leak the secret", () => {
    it("does not include the secret value in the error", () => {
      const secret = "SENTINEL_UNIQUE_MARKER_SHOULD_NOT_APPEAR_IN_ERROR";
      // it's length 49, placeholder regex won't match → so make it short instead
      const shortSecret = "SENTINEL_UNIQUE_MARKER";
      try {
        validateJwtSecret(shortSecret);
        expect.unreachable();
      } catch (err) {
        expect(err.message).not.toContain("SENTINEL_UNIQUE_MARKER");
      }
      expect(secret.length).toBeGreaterThan(0); // silence unused-var linter
    });
  });
});
