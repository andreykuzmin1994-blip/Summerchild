/**
 * Simple in-memory TTL cache for expensive query results.
 * Scoped to a single process — appropriate for the DeKalb single-county pilot.
 * No external dependencies required.
 */

class QueryCache {
  constructor({ defaultTtlMs = 5 * 60 * 1000, maxEntries = 500 } = {}) {
    this._store = new Map();
    this._defaultTtlMs = defaultTtlMs;
    this._maxEntries = maxEntries;
  }

  /**
   * Get a cached value, or compute and cache it if missing/expired.
   * @param {string} key - Cache key
   * @param {Function} computeFn - Async function that produces the value
   * @param {number} [ttlMs] - Optional TTL override in milliseconds
   */
  async getOrCompute(key, computeFn, ttlMs) {
    const entry = this._store.get(key);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.value;
    }

    const value = await computeFn();
    this._set(key, value, ttlMs || this._defaultTtlMs);
    return value;
  }

  /**
   * Invalidate a specific key or all keys matching a prefix.
   */
  invalidate(keyOrPrefix) {
    if (this._store.has(keyOrPrefix)) {
      this._store.delete(keyOrPrefix);
      return;
    }
    // Prefix match
    for (const key of this._store.keys()) {
      if (key.startsWith(keyOrPrefix)) {
        this._store.delete(key);
      }
    }
  }

  _set(key, value, ttlMs) {
    // Evict oldest entries if at capacity
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

// Shared instances for different cache domains
const eligibilityCache = new QueryCache({ defaultTtlMs: 15 * 60 * 1000, maxEntries: 200 });
const statsCache = new QueryCache({ defaultTtlMs: 2 * 60 * 1000, maxEntries: 50 });

module.exports = { QueryCache, eligibilityCache, statsCache };
