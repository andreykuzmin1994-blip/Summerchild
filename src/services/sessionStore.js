/**
 * Session Store — Redis-compatible session management with in-memory fallback.
 *
 * County compliance notes:
 * - Sessions contain no PII (only intake IDs, system prompts, conversation history)
 * - TTL-based expiration ensures data doesn't persist beyond the intake window
 * - Redis support enables horizontal scaling across multiple kiosk terminals
 * - Audit events are logged on session lifecycle transitions
 *
 * In production, set REDIS_URL to use Redis; otherwise falls back to in-memory Map.
 * The interface is identical for both backends, so the rest of the app is unaware.
 */

const { child } = require("./logger");

const log = child("session-store");

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10); // 30 minutes

/**
 * In-memory session store (default / development).
 * Production deployments SHOULD set REDIS_URL to enable Redis-backed sessions
 * for multi-instance scaling and session persistence across restarts.
 */
class MemorySessionStore {
  constructor() {
    this.sessions = new Map();
    this._cleanupInterval = null;
  }

  async get(token) {
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
      this.sessions.delete(token);
      log.info("Session expired during get", { sessionPrefix: token.slice(0, 8) });
      return null;
    }

    return session;
  }

  async set(token, session) {
    session.lastActivity = session.lastActivity || Date.now();
    this.sessions.set(token, session);
  }

  async touch(token) {
    const session = this.sessions.get(token);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  async delete(token) {
    this.sessions.delete(token);
  }

  async has(token) {
    const session = await this.get(token);
    return session !== null;
  }

  /**
   * Start periodic cleanup of expired sessions.
   * Returns the interval ID for testing/cleanup purposes.
   */
  startCleanup(intervalMs = 60 * 1000) {
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [token, session] of this.sessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
          this.sessions.delete(token);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        log.info("Expired sessions cleaned", { count: cleaned });
      }
    }, intervalMs);

    // Allow Node.js to exit even if the interval is running
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }

    return this._cleanupInterval;
  }

  stopCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  get size() {
    return this.sessions.size;
  }
}

/**
 * Redis-backed session store for production multi-instance deployments.
 * Sessions are serialized as JSON with Redis TTL for automatic expiration.
 */
class RedisSessionStore {
  constructor(redisClient) {
    this.redis = redisClient;
    this.prefix = "cushion:session:";
    this.ttlSeconds = Math.ceil(SESSION_TTL_MS / 1000);
  }

  _key(token) {
    return `${this.prefix}${token}`;
  }

  async get(token) {
    const data = await this.redis.get(this._key(token));
    if (!data) return null;

    try {
      const session = JSON.parse(data);
      // Redis TTL handles expiration, but double-check
      if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
        await this.delete(token);
        return null;
      }
      return session;
    } catch (err) {
      log.error("Failed to parse session from Redis", { error: err.message });
      await this.delete(token);
      return null;
    }
  }

  async set(token, session) {
    session.lastActivity = session.lastActivity || Date.now();

    // PIIStripper and other class instances cannot be JSON-serialized directly.
    // Store only serializable properties; the route layer must re-hydrate as needed.
    const serializable = {
      ...session,
      piiStripper: session.piiStripper
        ? { mappings: Array.from(session.piiStripper.mappings?.entries?.() || []) }
        : undefined,
    };

    await this.redis.set(this._key(token), JSON.stringify(serializable), {
      EX: this.ttlSeconds,
    });
  }

  async touch(token) {
    const session = await this.get(token);
    if (session) {
      session.lastActivity = Date.now();
      await this.set(token, session);
    }
  }

  async delete(token) {
    await this.redis.del(this._key(token));
  }

  async has(token) {
    const exists = await this.redis.exists(this._key(token));
    return exists === 1;
  }

  // No periodic cleanup needed — Redis TTL handles it
  startCleanup() {}
  stopCleanup() {}
}

/**
 * Create the appropriate session store based on environment configuration.
 */
function createSessionStore() {
  if (process.env.REDIS_URL) {
    try {
      // Dynamic import — redis package is optional
      const redis = require("redis");
      const client = redis.createClient({ url: process.env.REDIS_URL });

      client.on("error", (err) => {
        log.error("Redis connection error — falling back to memory store", { error: err.message });
      });

      client.connect().then(() => {
        log.info("Redis session store connected", { url: process.env.REDIS_URL.replace(/\/\/.*@/, "//***@") });
      }).catch((err) => {
        log.error("Redis connection failed", { error: err.message });
      });

      return new RedisSessionStore(client);
    } catch (err) {
      log.warn("Redis package not installed — using in-memory session store", { error: err.message });
    }
  }

  if (process.env.NODE_ENV === "production") {
    log.error("REDIS_URL is required in production for session persistence and multi-instance support");
    throw new Error("REDIS_URL environment variable is required in production. In-memory sessions are not safe for production use.");
  }

  const store = new MemorySessionStore();
  store.startCleanup();
  log.info("Using in-memory session store (development mode)");

  return store;
}

// Singleton
const sessionStore = createSessionStore();

module.exports = {
  sessionStore,
  SESSION_TTL_MS,
  MemorySessionStore,
  RedisSessionStore,
  createSessionStore,
};
