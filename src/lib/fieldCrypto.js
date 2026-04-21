/**
 * Field-level encryption for sensitive at-rest values (NIST 800-53 SC-28).
 *
 * Two coexisting wire formats:
 *
 *   v1  — ConversationLog.content. AAD = intakeId (UTF-8). Uses the root
 *         ring key directly (no subkey derivation). Preserved bit-for-bit
 *         for backward compatibility with existing rows. Exposed as
 *         `encryptV1` / `decryptV1` / `safeDecryptV1`.
 *
 *   v2  — All other PII columns (Applicant.displayName, IntakeReview.notes,
 *         and future additions). Wire format `v2.<keyVersion>:iv:tag:ct`.
 *         AES-GCM subkey derived via HKDF-SHA256 per (keyVersion, table,
 *         column) — a leak of one subkey does not compromise other columns.
 *         AAD = `cushion-v2|${table}|${column}|${countyId}|${rowId}` —
 *         binds ciphertext to its exact row and tenant, making DB-dump
 *         swap attacks (row-to-row, column-to-column, county-to-county)
 *         fail the auth-tag check. Exposed as `encrypt` / `decrypt` /
 *         `safeDecrypt`.
 *
 * Both formats:
 *   - AES-256-GCM (Node's built-in `crypto` module).
 *   - Key RING: FIELD_ENCRYPTION_KEYS="v1:<b64>,v2:<b64>". The first entry
 *     is the active root-key writer; all entries are usable for decryption
 *     via their version tag. Zero-downtime rotation without schema change.
 *   - Legacy plaintext passthrough (shape-strict regex at module top).
 *   - Graceful decrypt: `safeDecrypt*` returns a sentinel and calls the
 *     onFailure hook for audit logging; never throws into the caller.
 *   - Startup validation refuses prod boot on missing/placeholder keys.
 *
 * Key management:
 *   - Development: if FIELD_ENCRYPTION_KEYS is unset, a deterministic
 *     dev key is used with a loud stderr warning. Production MUST provide
 *     a real key; the validator rejects the dev key in prod.
 *   - Rotation: add a new version to the head of FIELD_ENCRYPTION_KEYS;
 *     redeploy. New writes use the new key; old reads still decrypt via
 *     the trailing keys. A follow-up re-encrypt script can rewrite legacy
 *     rows at a safe pace.
 *
 * TODO(FedRAMP): migrate to AWS KMS envelope encryption for production so
 * the app role has encrypt-only access and decrypt goes through a separate
 * IAM-gated path.
 */

const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ACTIVE_VERSION = "v1";
const SENTINEL_DECRYPT_FAILED = "[decryption error — logged for investigation]";

// Shape-strict ciphertext pattern covering both v1 and v2 wire formats.
// v1 tag: `v1` | v2 tag: `v2.v1` (format.keyVersion). The tail is 3 base64
// segments (iv, auth tag, ct). IV and tag are always non-empty; the final
// ct segment may be empty for empty-string plaintext. Downstream length
// checks catch anything that slips through (wrong iv/tag size → throws).
const CIPHERTEXT_SHAPE =
  /^v\d+(\.v\d+)?:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/;

// Deterministic dev-only key. 32 bytes base64.
// MUST never be accepted in production — see validateFieldEncryptionKeys().
const DEV_KEY_B64 = "ZGV2LW9ubHktZG8tbm90LXVzZS1pbi1wcm9kdWN0aW9uLTEyMw==";
const PLACEHOLDER_REGEX = /your[-_]?key|change[-_]?me|placeholder/i;

let cachedRing = null; // Map<version, Buffer>
let cachedActive = null; // string version

function parseKeyEntry(entry) {
  const colonIdx = entry.indexOf(":");
  if (colonIdx < 0) {
    throw new Error("FATAL: FIELD_ENCRYPTION_KEYS entry must be 'vN:<base64>'");
  }
  const version = entry.slice(0, colonIdx).trim();
  const b64 = entry.slice(colonIdx + 1).trim();
  if (!/^v\d+$/.test(version)) {
    throw new Error(`FATAL: FIELD_ENCRYPTION_KEYS version must match /v\\d+/ (got "${version}")`);
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `FATAL: FIELD_ENCRYPTION_KEYS[${version}] must decode to ${KEY_BYTES} bytes. ` +
      "Generate with: openssl rand -base64 32"
    );
  }
  return { version, key: buf, raw: b64 };
}

function validateFieldEncryptionKeys() {
  cachedRing = null;
  cachedActive = null;

  const raw = process.env.FIELD_ENCRYPTION_KEYS;
  const env = process.env.NODE_ENV;

  if (!raw || raw.trim() === "") {
    if (env === "production") {
      throw new Error(
        "FATAL: FIELD_ENCRYPTION_KEYS is required in production. " +
        "Format: FIELD_ENCRYPTION_KEYS=\"v1:<base64-32-bytes>\" " +
        "(generate with: openssl rand -base64 32)"
      );
    }
    // Development / test: use dev key with a warning.
    console.warn(
      "[fieldCrypto] WARNING: FIELD_ENCRYPTION_KEYS not set — using insecure dev key. " +
      "Set FIELD_ENCRYPTION_KEYS before running in production."
    );
    const ring = new Map();
    ring.set(ACTIVE_VERSION, Buffer.from(DEV_KEY_B64, "base64"));
    cachedRing = ring;
    cachedActive = ACTIVE_VERSION;
    return;
  }

  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("FATAL: FIELD_ENCRYPTION_KEYS is empty");
  }

  const ring = new Map();
  let active = null;
  for (const entry of entries) {
    const { version, key, raw: keyRaw } = parseKeyEntry(entry);
    if (env === "production" && (keyRaw === DEV_KEY_B64 || PLACEHOLDER_REGEX.test(keyRaw))) {
      throw new Error("FATAL: FIELD_ENCRYPTION_KEYS contains a dev/placeholder key in production");
    }
    if (ring.has(version)) {
      throw new Error(`FATAL: FIELD_ENCRYPTION_KEYS has duplicate version "${version}"`);
    }
    ring.set(version, key);
    if (active === null) active = version; // first entry is active writer
  }
  cachedRing = ring;
  cachedActive = active;
}

function getActiveKey() {
  if (!cachedRing) validateFieldEncryptionKeys();
  return { version: cachedActive, key: cachedRing.get(cachedActive) };
}

function getKeyByVersion(version) {
  if (!cachedRing) validateFieldEncryptionKeys();
  return cachedRing.get(version);
}

function isEncrypted(s) {
  return typeof s === "string" && CIPHERTEXT_SHAPE.test(s);
}

// ---------------------------------------------------------------------
// v1 — ConversationLog.content. AAD = intakeId. Kept bit-identical for
// backward compat with existing DB rows. Do NOT change this format.
// ---------------------------------------------------------------------

function encryptV1(plaintext, intakeId) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== "string") {
    throw new TypeError("fieldCrypto.encryptV1: plaintext must be a string");
  }
  if (!intakeId || typeof intakeId !== "string") {
    throw new TypeError("fieldCrypto.encryptV1: intakeId (AAD) is required");
  }
  const { version, key } = getActiveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(intakeId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decryptV1(ciphertext, intakeId) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  if (typeof ciphertext !== "string") return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext; // legacy plaintext

  const parts = ciphertext.split(":");
  const [firstTag] = parts;
  if (firstTag.includes(".")) {
    throw new Error("fieldCrypto.decryptV1: v2 ciphertext — use decrypt() instead");
  }

  if (!intakeId || typeof intakeId !== "string") {
    throw new TypeError("fieldCrypto.decryptV1: intakeId (AAD) is required");
  }

  const [version, ivB64, tagB64, ctB64] = parts;
  const key = getKeyByVersion(version);
  if (!key) throw new Error(`fieldCrypto.decryptV1: unknown key version "${version}"`);

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("fieldCrypto.decryptV1: bad iv/tag length");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(intakeId, "utf8"));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

function safeDecryptV1(ciphertext, intakeId, onFailure) {
  try {
    return decryptV1(ciphertext, intakeId);
  } catch (err) {
    if (typeof onFailure === "function") {
      try { onFailure({ intakeId, error: err.message, name: err.name }); } catch { /* never rethrow */ }
    }
    return SENTINEL_DECRYPT_FAILED;
  }
}

// ---------------------------------------------------------------------
// v2 — HKDF subkey per (keyVersion, table, column) + richer AAD that
// binds ciphertext to { table, column, countyId, rowId }.
// ---------------------------------------------------------------------

const HKDF_HASH = "sha256";
const HKDF_SALT = Buffer.alloc(0); // RFC 5869 §3.1: empty salt is OK for a pre-shared root key.
const HKDF_INFO_VERSION_BYTE = 0x01; // bump if info-string format changes; irreversible.
const V2_FORMAT_TAG = "v2";
const AAD_VERSION_PREFIX = "cushion-v2";

// Subkey cache: keyed by `${keyVersion}|${table}|${column}`.
// Bounded by (ring size × tables × columns) — currently <20 entries for
// the foreseeable future. NOT a memory leak; leave comment for future
// security reviewers.
const subkeyCache = new Map();

function deriveSubkey(keyVersion, rootKey, table, column) {
  const cacheKey = `${keyVersion}|${table}|${column}`;
  const hit = subkeyCache.get(cacheKey);
  if (hit) return hit;
  // info = [0x01] || "cushion-gov|<table>|<column>|<keyVersion>"
  // The version byte protects against future info-format changes
  // permanently orphaning ciphertexts (Reviewer B, blocker #2).
  const info = Buffer.concat([
    Buffer.from([HKDF_INFO_VERSION_BYTE]),
    Buffer.from(`cushion-gov|${table}|${column}|${keyVersion}`, "utf8"),
  ]);
  // hkdfSync returns an ArrayBuffer on Node 18+; wrap in Buffer before
  // passing to createCipheriv (Reviewer B, blocker #1).
  const derived = Buffer.from(crypto.hkdfSync(HKDF_HASH, rootKey, HKDF_SALT, info, KEY_BYTES));
  subkeyCache.set(cacheKey, derived);
  return derived;
}

function buildV2AAD({ table, column, countyId, rowId }) {
  // Pipe-delimited; context fields are validated to not contain `|`.
  // Prefixed with AAD_VERSION_PREFIX so a future format change can be
  // distinguished from an AAD mismatch.
  return Buffer.from(
    `${AAD_VERSION_PREFIX}|${table}|${column}|${countyId}|${rowId}`,
    "utf8"
  );
}

function assertV2Ctx(ctx, fn) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError(`fieldCrypto.${fn}: context { table, column, countyId, rowId } is required`);
  }
  for (const key of ["table", "column", "countyId", "rowId"]) {
    const v = ctx[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new TypeError(`fieldCrypto.${fn}: context.${key} must be a non-empty string`);
    }
    // `|` is our AAD delimiter — forbid it to keep encoding unambiguous.
    if (v.includes("|")) {
      throw new TypeError(`fieldCrypto.${fn}: context.${key} must not contain '|'`);
    }
  }
}

function encrypt(plaintext, ctx) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== "string") {
    throw new TypeError("fieldCrypto.encrypt: plaintext must be a string");
  }
  assertV2Ctx(ctx, "encrypt");
  const { version: keyVersion, key: rootKey } = getActiveKey();
  const subkey = deriveSubkey(keyVersion, rootKey, ctx.table, ctx.column);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, subkey, iv);
  cipher.setAAD(buildV2AAD(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V2_FORMAT_TAG}.${keyVersion}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decrypt(ciphertext, ctx) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  if (typeof ciphertext !== "string") return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext; // legacy plaintext passthrough

  const parts = ciphertext.split(":");
  if (parts.length !== 4) throw new Error("fieldCrypto.decrypt: malformed ciphertext");
  const [formatTag, ivB64, tagB64, ctB64] = parts;

  if (!formatTag.startsWith(`${V2_FORMAT_TAG}.`)) {
    throw new Error("fieldCrypto.decrypt: v1 ciphertext requires decryptV1()");
  }
  assertV2Ctx(ctx, "decrypt");
  const keyVersion = formatTag.slice(V2_FORMAT_TAG.length + 1);
  const rootKey = getKeyByVersion(keyVersion);
  if (!rootKey) throw new Error(`fieldCrypto.decrypt: unknown key version "${keyVersion}"`);

  const subkey = deriveSubkey(keyVersion, rootKey, ctx.table, ctx.column);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("fieldCrypto.decrypt: bad iv/tag length");
  }
  const decipher = crypto.createDecipheriv(ALGO, subkey, iv);
  decipher.setAAD(buildV2AAD(ctx));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function safeDecrypt(ciphertext, ctx, onFailure) {
  try {
    return decrypt(ciphertext, ctx);
  } catch (err) {
    if (typeof onFailure === "function") {
      try {
        onFailure({ ctx, error: err.message, name: err.name });
      } catch { /* never rethrow */ }
    }
    return SENTINEL_DECRYPT_FAILED;
  }
}

// Validate at module load so misconfig fails boot (fail-closed, NIST SC-28).
validateFieldEncryptionKeys();

module.exports = {
  // v2 API (primary): for all new PII columns.
  encrypt,
  decrypt,
  safeDecrypt,
  // v1 API (legacy, ConversationLog.content only):
  encryptV1,
  decryptV1,
  safeDecryptV1,
  // utilities:
  isEncrypted,
  validateFieldEncryptionKeys,
  SENTINEL_DECRYPT_FAILED,
  V2_FORMAT_TAG,
  AAD_VERSION_PREFIX,
};
