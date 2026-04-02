const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const { child } = require("./logger");

const cbLog = child("circuit-breaker");

// Circuit breaker states
const STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

// Provider-specific model mappings
const PROVIDER_MODELS = {
  anthropic: {
    HAIKU: "claude-haiku-4-5-20251001",
    SONNET: "claude-sonnet-4-20250514",
  },
  openai: {
    HAIKU: "gpt-4o-mini",
    SONNET: "gpt-4o",
  },
};

class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 60000 } = {}) {
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.lastFailureTime = null;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.state = STATE.CLOSED;
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
    }
  }

  canAttempt() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }
    // HALF_OPEN — allow one attempt
    return true;
  }
}

class AIProvider {
  constructor() {
    this.anthropic = null;
    this.openai = null;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(process.env.AI_FAILOVER_THRESHOLD || "3", 10),
      resetTimeoutMs: parseInt(process.env.AI_FAILOVER_RESET_MS || "60000", 10),
    });
    this.activeProvider = "anthropic";
    this.failoverLog = [];

    this._initClients();
  }

  _initClients() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  /**
   * Check if a fallback provider is configured and available.
   */
  hasFallback() {
    return this.openai !== null;
  }

  /**
   * Get the currently active provider name.
   */
  getActiveProvider() {
    return this.activeProvider;
  }

  /**
   * Get recent failover events for audit/monitoring.
   */
  getFailoverLog() {
    return this.failoverLog.slice(-50);
  }

  /**
   * Determine if an error is worth failing over for.
   * In a kiosk environment, keeping the session alive for the applicant
   * takes priority — fail over on any error that the applicant can't fix.
   */
  _isFailoverError(error) {
    // Service-level failures
    if (error.status === 529) return true; // Anthropic overloaded
    if (error.status === 503) return true; // Service unavailable
    if (error.status === 502) return true; // Bad gateway
    if (error.status === 500) return true; // Internal server error
    if (error.status === 408) return true; // Request timeout

    // Auth failures — API key revoked, rotated, or expired mid-session.
    // The applicant at the kiosk can't fix this, so fail over to keep
    // the intake alive. The failover log alerts ops to fix the key.
    if (error.status === 401) return true; // Unauthorized
    if (error.status === 403) return true; // Forbidden

    // Network-level failures
    if (error.code === "ECONNREFUSED") return true;
    if (error.code === "ETIMEDOUT") return true;
    if (error.code === "ENOTFOUND") return true;
    if (error.message && error.message.includes("timeout")) return true;

    // Don't failover for:
    // 400 — bad request, likely a code bug that would hit both providers
    // 429 — rate limit, temporary, retry same provider
    return false;
  }

  /**
   * Log a failover event and persist to audit log for observability.
   * County compliance: all provider failures must be traceable for SLA reporting.
   */
  _logFailover(fromProvider, toProvider, error) {
    const entry = {
      timestamp: new Date().toISOString(),
      from: fromProvider,
      to: toProvider,
      reason: error.message || "Unknown error",
      errorStatus: error.status || null,
      circuitBreakerState: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount,
    };
    this.failoverLog.push(entry);

    // Keep failover log bounded
    if (this.failoverLog.length > 100) {
      this.failoverLog = this.failoverLog.slice(-50);
    }

    cbLog.error("AI provider failover", entry);

    // Persist to audit log asynchronously (non-blocking)
    try {
      const { logAuditEvent, EVENTS, ACTORS } = require("./auditLogger");
      logAuditEvent({
        type: EVENTS.AI_API_CALL,
        actorType: ACTORS.SYSTEM,
        actorId: "circuit-breaker",
        details: {
          event: "FAILOVER",
          ...entry,
        },
      }).catch(() => {
        // Audit persistence failure should not affect AI provider operations
      });
    } catch {
      // Ignore require/initialization errors during startup — non-critical path
    }
  }

  /**
   * Get circuit breaker metrics for observability dashboards.
   * Returns aggregate stats useful for county SLA reporting.
   */
  getMetrics() {
    const recentFailovers = this.failoverLog.slice(-50);
    const last24h = recentFailovers.filter(
      (e) => new Date(e.timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    return {
      activeProvider: this.activeProvider,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount,
        failureThreshold: this.circuitBreaker.failureThreshold,
        resetTimeoutMs: this.circuitBreaker.resetTimeoutMs,
        lastFailureTime: this.circuitBreaker.lastFailureTime
          ? new Date(this.circuitBreaker.lastFailureTime).toISOString()
          : null,
      },
      failoverStats: {
        total: this.failoverLog.length,
        last24Hours: last24h.length,
        lastFailover: recentFailovers.length > 0
          ? recentFailovers[recentFailovers.length - 1]
          : null,
      },
    };
  }

  /**
   * Send a message via Anthropic's API.
   */
  async _sendAnthropic(systemPrompt, messages, modelTier, sessionHash) {
    const model = PROVIDER_MODELS.anthropic[modelTier];

    const response = await this.anthropic.messages.create({
      model,
      max_tokens: 1024,
      metadata: sessionHash ? { user_id: sessionHash } : undefined,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    return {
      text: response.content[0].text,
      model,
      provider: "anthropic",
      usage: response.usage,
    };
  }

  /**
   * Send a message via OpenAI's API.
   */
  async _sendOpenAI(systemPrompt, messages, modelTier) {
    const model = PROVIDER_MODELS.openai[modelTier];

    // Convert Anthropic-style messages to OpenAI format
    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.map((c) => c.text).join(""),
      })),
    ];

    const response = await this.openai.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: openaiMessages,
    });

    return {
      text: response.choices[0].message.content,
      model,
      provider: "openai",
      usage: {
        input_tokens: response.usage?.prompt_tokens,
        output_tokens: response.usage?.completion_tokens,
      },
    };
  }

  /**
   * Send a message with automatic failover.
   *
   * @param {string} systemPrompt - The system prompt text
   * @param {Array} messages - Conversation history in Anthropic format
   * @param {string} modelTier - "HAIKU" or "SONNET"
   * @param {string|null} sessionHash - Hashed session token for metadata
   * @returns {Promise<{text: string, model: string, provider: string, usage: object}>}
   */
  async sendMessage(systemPrompt, messages, modelTier, sessionHash = null) {
    // Try primary provider (Anthropic) if circuit breaker allows
    if (this.anthropic && this.circuitBreaker.canAttempt()) {
      try {
        const result = await this._sendAnthropic(systemPrompt, messages, modelTier, sessionHash);
        this.circuitBreaker.recordSuccess();
        this.activeProvider = "anthropic";
        return result;
      } catch (error) {
        if (this._isFailoverError(error) && this.hasFallback()) {
          this.circuitBreaker.recordFailure();
          this._logFailover("anthropic", "openai", error);
          // Fall through to fallback
        } else {
          // Non-failover error (auth, bad request, rate limit) — throw as-is
          throw error;
        }
      }
    }

    // Fallback to OpenAI
    if (this.openai) {
      try {
        const result = await this._sendOpenAI(systemPrompt, messages, modelTier);
        this.activeProvider = "openai";
        return result;
      } catch (fallbackError) {
        // Both providers failed
        const err = new Error(
          `All AI providers failed. Primary (Anthropic): circuit breaker ${this.circuitBreaker.state}. ` +
          `Fallback (OpenAI): ${fallbackError.message}`
        );
        err.code = "ALL_PROVIDERS_FAILED";
        throw err;
      }
    }

    // No fallback configured, and primary is unavailable
    throw new Error(
      "Primary AI provider (Anthropic) is unavailable and no fallback provider is configured. " +
      "Set OPENAI_API_KEY in environment to enable failover."
    );
  }

  /**
   * Health check — returns status of each provider.
   */
  async healthCheck() {
    const status = {
      anthropic: { configured: !!this.anthropic, available: false },
      openai: { configured: !!this.openai, available: false },
      activeProvider: this.activeProvider,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount,
      },
    };

    // Quick test: list models to verify connectivity
    if (this.anthropic) {
      try {
        await this.anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        status.anthropic.available = true;
      } catch {
        status.anthropic.available = false;
      }
    }

    if (this.openai) {
      try {
        await this.openai.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        status.openai.available = true;
      } catch {
        status.openai.available = false;
      }
    }

    return status;
  }
}

// Singleton instance
const aiProvider = new AIProvider();

module.exports = { aiProvider, AIProvider, PROVIDER_MODELS, CircuitBreaker };
