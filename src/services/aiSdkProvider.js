/**
 * AI SDK Provider — unified LLM interface via Vercel AI SDK.
 *
 * Replaces the hand-rolled aiProvider.js with AI SDK's provider abstraction.
 * Benefits:
 *   - Single interface for Anthropic + OpenAI (and any future providers)
 *   - Built-in retry/timeout handling
 *   - Cleaner message format conversion
 *   - Same circuit breaker + failover audit trail as before
 *
 * The circuit breaker logic is retained because AI SDK's built-in fallback
 * doesn't include OPEN → HALF_OPEN → CLOSED state tracking, which we need
 * for the county SLA dashboard (/api/health/ai endpoint).
 */

const { generateText } = require("ai");
const { createAnthropic } = require("@ai-sdk/anthropic");
const { createOpenAI } = require("@ai-sdk/openai");
const { child } = require("./logger");

const cbLog = child("circuit-breaker");

// ── Circuit breaker (unchanged from aiProvider.js) ──────────────────

const STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

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
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN — allow one attempt
  }
}

// ── Provider model mappings ─────────────────────────────────────────

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

// ── AI SDK Provider class ───────────────────────────────────────────

class AISdkProvider {
  constructor() {
    this.anthropicProvider = null;
    this.openaiProvider = null;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(process.env.AI_FAILOVER_THRESHOLD || "3", 10),
      resetTimeoutMs: parseInt(process.env.AI_FAILOVER_RESET_MS || "60000", 10),
    });
    this.activeProvider = "anthropic";
    this.failoverLog = [];

    this._initProviders();
  }

  _initProviders() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropicProvider = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openaiProvider = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  hasFallback() {
    return this.openaiProvider !== null;
  }

  getActiveProvider() {
    return this.activeProvider;
  }

  getFailoverLog() {
    return this.failoverLog.slice(-50);
  }

  /**
   * Determine if an error warrants failing over to the backup provider.
   */
  _isFailoverError(error) {
    const status = error.status || error.statusCode;
    if ([529, 503, 502, 500, 408, 401, 403].includes(status)) return true;
    if (error.code === "ECONNREFUSED") return true;
    if (error.code === "ETIMEDOUT") return true;
    if (error.code === "ENOTFOUND") return true;
    if (error.message && error.message.includes("timeout")) return true;
    return false;
  }

  _logFailover(fromProvider, toProvider, error) {
    const entry = {
      timestamp: new Date().toISOString(),
      from: fromProvider,
      to: toProvider,
      reason: error.message || "Unknown error",
      errorStatus: error.status || error.statusCode || null,
      circuitBreakerState: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount,
    };
    this.failoverLog.push(entry);
    if (this.failoverLog.length > 100) {
      this.failoverLog = this.failoverLog.slice(-50);
    }
    cbLog.error("AI provider failover", entry);

    try {
      const { logAuditEvent, EVENTS, ACTORS } = require("./auditLogger");
      logAuditEvent({
        type: EVENTS.AI_API_CALL,
        actorType: ACTORS.SYSTEM,
        actorId: "circuit-breaker",
        details: { event: "FAILOVER", ...entry },
      }).catch(() => {});
    } catch {
      // Non-critical path
    }
  }

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
   * Get the AI SDK model instance for a given provider + tier.
   */
  _getModel(providerName, modelTier) {
    const modelId = PROVIDER_MODELS[providerName][modelTier];
    if (providerName === "anthropic") {
      return this.anthropicProvider(modelId);
    }
    return this.openaiProvider(modelId);
  }

  /**
   * Convert Anthropic-style messages to AI SDK's format.
   * AI SDK uses { role, content } where content is always a string.
   */
  _normalizeMessages(messages) {
    return messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : m.content.map((c) => c.text).join(""),
    }));
  }

  /**
   * Call generateText with a specific provider.
   */
  async _callProvider(providerName, systemPrompt, messages, modelTier) {
    const model = this._getModel(providerName, modelTier);
    const normalizedMessages = this._normalizeMessages(messages);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages: normalizedMessages,
      maxTokens: 1024,
      providerOptions: providerName === "anthropic" ? {
        anthropic: {
          // Enable prompt caching for the system prompt
          cacheControl: { type: "ephemeral" },
        },
      } : undefined,
    });

    return {
      text: result.text,
      model: PROVIDER_MODELS[providerName][modelTier],
      provider: providerName,
      usage: {
        input_tokens: result.usage?.promptTokens,
        output_tokens: result.usage?.completionTokens,
      },
    };
  }

  /**
   * Send a message with automatic failover.
   *
   * @param {string} systemPrompt - The system prompt text
   * @param {Array} messages - Conversation history in Anthropic format
   * @param {string} modelTier - "HAIKU" or "SONNET"
   * @param {string|null} _sessionHash - Unused (kept for API compatibility)
   * @returns {Promise<{text: string, model: string, provider: string, usage: object}>}
   */
  async sendMessage(systemPrompt, messages, modelTier, _sessionHash = null) {
    // Try primary provider if circuit breaker allows
    if (this.anthropicProvider && this.circuitBreaker.canAttempt()) {
      try {
        const result = await this._callProvider("anthropic", systemPrompt, messages, modelTier);
        this.circuitBreaker.recordSuccess();
        this.activeProvider = "anthropic";
        return result;
      } catch (error) {
        if (this._isFailoverError(error) && this.hasFallback()) {
          this.circuitBreaker.recordFailure();
          this._logFailover("anthropic", "openai", error);
        } else {
          throw error;
        }
      }
    }

    // Fallback to OpenAI
    if (this.openaiProvider) {
      try {
        const result = await this._callProvider("openai", systemPrompt, messages, modelTier);
        this.activeProvider = "openai";
        return result;
      } catch (fallbackError) {
        const err = new Error(
          `All AI providers failed. Primary (Anthropic): circuit breaker ${this.circuitBreaker.state}. ` +
          `Fallback (OpenAI): ${fallbackError.message}`
        );
        err.code = "ALL_PROVIDERS_FAILED";
        throw err;
      }
    }

    throw new Error(
      "Primary AI provider (Anthropic) is unavailable and no fallback provider is configured. " +
      "Set OPENAI_API_KEY in environment to enable failover."
    );
  }

  /**
   * Health check — verifies connectivity to each provider.
   */
  async healthCheck() {
    const status = {
      anthropic: { configured: !!this.anthropicProvider, available: false },
      openai: { configured: !!this.openaiProvider, available: false },
      activeProvider: this.activeProvider,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount,
      },
    };

    if (this.anthropicProvider) {
      try {
        await generateText({
          model: this.anthropicProvider("claude-haiku-4-5-20251001"),
          maxTokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        status.anthropic.available = true;
      } catch {
        status.anthropic.available = false;
      }
    }

    if (this.openaiProvider) {
      try {
        await generateText({
          model: this.openaiProvider("gpt-4o-mini"),
          maxTokens: 1,
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

// Singleton
const aiSdkProvider = new AISdkProvider();

module.exports = { aiSdkProvider, AISdkProvider, PROVIDER_MODELS, CircuitBreaker };
