// Test environment bootstrap.
// Loaded by vitest before any test files (see vitest.config.js).
//
// Sets strong defaults for security-validated env vars so that modules like
// src/middleware/auth.js can be imported during tests. Real tests override
// these values as needed.

if (!process.env.JWT_SECRET) {
  // 64-char hex — satisfies validateJwtSecret's format allowlist.
  process.env.JWT_SECRET =
    "0f3b8c2d4e6a1f9b7c5d2e8a4f1b6c9d3e7a2f8b5c1d9e6a4f2b8c7d3e1a9f5b";
}

process.env.NODE_ENV = process.env.NODE_ENV || "test";
