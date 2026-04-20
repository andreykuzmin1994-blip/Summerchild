/**
 * Field-level encryption for sensitive at-rest values (NIST 800-53 SC-28).
 *
 * Used for ConversationLog.content, which stores free-text applicant
 * utterances. The schema is otherwise PII-minimized — this is the highest
 * PII-exposure surface in the DB.
 *
 * Design (synthesized from Coder proposal + Reviewer amendments):
 *
 *   - AES-256-GCM via Node's built-in `crypto` module (no new deps).
 *   - Key RING: FIELD_ENCRYPTION_KEYS="v1:<b64>,v2:<b64>". The first entry
 *     is the active writer; all entries are usable for decryption. This
 *     enables zero-downtime key rotation without a schema migration.
 *   - Associated Data = intakeId (UTF-8). Binds each ciphertext to the
 *     intake it belongs to, preventing DB-dump swap attacks between
 *     cases (FedRAMP AC-4 / SI-7).
 *   - Versioned ciphertext format: `<version>:<b64-iv>:<b64-tag>:<b64-ct>`
 *     e.g. `v1:abc...:def...:ghi...`.
 *   - Legacy passthrough: shape-strict regex, not bare prefix. A user
 *     message like "v1: my rent is due" reads back unchanged because it
 *     doesn't match the full 4-segment base64 shape.
 *   - Graceful decrypt: `safeDecrypt(ct, intakeId)` returns a sentinel
 *     string on auth-tag failure (tampering, wrong key, wrong AAD) and
 *     never throws into the caller's response path. Surfaces the failure
 *     via audit logging so investigators can follow up.
 *   - Startup validation: module-load check refuses to boot in production
 *     if FIELD_ENCRYPTION_KEYS is missing, malformed, or contains the
 *     well-known dev placeholder.
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

// Shape-strict ciphertext pattern: version + 3 base64 segments. IV and tag
// are always non-empty; the final ct segment may be empty for empty-string
// plaintext. Downstream length checks in decrypt() catch anything that
// slips through (wrong iv/tag size → throws).
const CIPHERTEXT_SHAPE = /^v\d+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/;

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

/**
 * Encrypt plaintext with the active key, binding to the given intakeId
 * as Associated Data (AAD).
 *
 * @param {string} plaintext
 * @param {string} intakeId — bound as AAD; required
 * @returns {string} versioned ciphertext
 */
function encrypt(plaintext, intakeId) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== "string") {
    throw new TypeError("fieldCrypto.encrypt: plaintext must be a string");
  }
  if (!intakeId || typeof intakeId !== "string") {
    throw new TypeError("fieldCrypto.encrypt: intakeId (AAD) is required");
  }
  const { version, key } = getActiveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(intakeId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a versioned ciphertext bound to intakeId. Throws on:
 *   - malformed shape
 *   - unknown key version
 *   - auth-tag verification failure (tampering / wrong AAD / wrong key)
 *
 * Most callers should use safeDecrypt() instead — it catches these
 * failures and returns a sentinel + audit hook.
 *
 * Legacy passthrough: a string that does not match the strict ciphertext
 * shape is returned unchanged. This lets the system read DB rows written
 * before this feature shipped.
 */
function decrypt(ciphertext, intakeId) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  if (typeof ciphertext !== "string") return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext; // legacy plaintext

  if (!intakeId || typeof intakeId !== "string") {
    throw new TypeError("fieldCrypto.decrypt: intakeId (AAD) is required");
  }

  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  const key = getKeyByVersion(version);
  if (!key) {
    throw new Error(`fieldCrypto.decrypt: unknown key version "${version}"`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("fieldCrypto.decrypt: bad iv/tag length");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(intakeId, "utf8"));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Decrypt-or-sentinel. Callers can safely use the result in responses
 * without a try/catch of their own. On failure:
 *   - returns SENTINEL_DECRYPT_FAILED
 *   - calls onFailure({ intakeId, error }) if provided, so callers can
 *     emit an audit event. Must not throw.
 *   - never returns raw ciphertext, IV, or tag bytes.
 */
function safeDecrypt(ciphertext, intakeId, onFailure) {
  try {
    return decrypt(ciphertext, intakeId);
  } catch (err) {
    if (typeof onFailure === "function") {
      try { onFailure({ intakeId, error: err.message, name: err.name }); } catch { /* never rethrow */ }
    }
    return SENTINEL_DECRYPT_FAILED;
  }
}

// Validate at module load so misconfig fails boot (fail-closed, NIST SC-28).
validateFieldEncryptionKeys();

module.exports = {
  encrypt,
  decrypt,
  safeDecrypt,
  isEncrypted,
  validateFieldEncryptionKeys,
  SENTINEL_DECRYPT_FAILED,
};
