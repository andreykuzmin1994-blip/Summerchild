const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const path = require("path");
const { apiLimiter } = require("./middleware/rateLimiter");
const { ipAllowlistMiddleware } = require("./middleware/ipAllowlist");
const { validateSystemPrompt } = require("./middleware/systemPromptValidator");
const { buildSystemPrompt } = require("./services/aiAssistant");
const { verifyAuditLogImmutability } = require("./services/auditLogger");
const { retentionScheduler } = require("./services/retentionScheduler");
const { correlationMiddleware, requestLogMiddleware, child } = require("./services/logger");

const intakeRoutes = require("./routes/intake");
const caseworkerRoutes = require("./routes/caseworker");
const adminRoutes = require("./routes/admin");

const log = child("app");
const app = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy hop so req.ip / req.secure / req.protocol reflect
// the real client (TLS-terminating load balancer, nginx, CloudFront).
// Required by express-rate-limit for per-IP keying and for helmet HSTS to
// be meaningful. See NIST 800-53 SC-7 / SC-8.
app.set("trust proxy", 1);

// Correlation ID + structured request logging (CJIS audit trail support)
app.use(correlationMiddleware);
app.use(requestLogMiddleware);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "no-referrer" },
}));

// CORS — validate origin in production
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
if (process.env.NODE_ENV === "production") {
  if (!corsOrigin || corsOrigin === "*" || corsOrigin.includes("localhost")) {
    throw new Error("CORS_ORIGIN must be a specific HTTPS domain in production (not wildcard or localhost)");
  }
  if (!corsOrigin.startsWith("https://")) {
    throw new Error("CORS_ORIGIN must use HTTPS in production");
  }
}
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Session-Token"],
  maxAge: 3600,
}));

// Body parsing
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

// IP allowlist — restrict access to county network ranges
app.use(ipAllowlistMiddleware);

// Rate limiting
app.use("/api", apiLimiter);

// API Routes
app.use("/api/intake", intakeRoutes);
app.use("/api/caseworker", caseworkerRoutes);
app.use("/api/admin", adminRoutes);

// Public health check — minimal liveness probe (no internal details)
app.get("/api/health", async (req, res) => {
  const prisma = require("./lib/prisma");

  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    health.status = "degraded";
  }

  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

// Detailed health check — DB, session store, memory (auth required)
app.get("/api/health/detailed", async (req, res) => {
  const jwt = require("jsonwebtoken");
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!["SUPERVISOR", "ADMIN"].includes(decoded.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const prismaClient = require("./lib/prisma");
  const { sessionStore } = require("./services/sessionStore");

  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version || "1.0.0",
    checks: {},
  };

  try {
    await prismaClient.$queryRaw`SELECT 1`;
    health.checks.database = { status: "ok" };
  } catch {
    health.checks.database = { status: "error", message: "Database connection failed" };
    health.status = "degraded";
  }

  health.checks.sessions = {
    status: "ok",
    type: process.env.REDIS_URL ? "redis" : "memory",
    activeSessions: sessionStore.size ?? "unknown",
  };

  const mem = process.memoryUsage();
  health.checks.memory = {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
  };

  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

// AI provider health check (shows active provider, circuit breaker state, failover log, metrics)
// Protected: exposes operational details (provider keys status, failover history)
app.get("/api/health/ai", async (req, res) => {
  // Inline auth check — only supervisors/admins should see AI provider internals
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const jwt = require("jsonwebtoken");
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!["SUPERVISOR", "ADMIN"].includes(decoded.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const { aiProvider } = require("./services/aiProvider");
  const status = await aiProvider.healthCheck();
  status.recentFailovers = aiProvider.getFailoverLog();
  status.metrics = aiProvider.getMetrics();
  res.json(status);
});

// Serve React frontend in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../client/dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../client/dist/index.html"));
  });
}

// Startup validation
async function startServer() {
  try {
    // Validate required environment variables in production
    const requiredEnvVars = ["DATABASE_URL", "JWT_SECRET"];
    if (process.env.NODE_ENV === "production") {
      requiredEnvVars.push("ANTHROPIC_API_KEY", "CORS_ORIGIN");
    }
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // Validate CORS_ORIGIN is not localhost in production
    if (process.env.NODE_ENV === "production" && process.env.CORS_ORIGIN?.includes("localhost")) {
      throw new Error("CORS_ORIGIN must not reference localhost in production");
    }

    // Refuse to start in production with insecure cookies enabled (NIST SC-8).
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_COOKIES === "true") {
      throw new Error("ALLOW_INSECURE_COOKIES=true is forbidden in production");
    }

    // Validate system prompt contains no PII
    const apiKeyPlaceholder = "sk-ant" + "-...";
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== apiKeyPlaceholder) {
      const systemPrompt = await buildSystemPrompt("GA", 2026);
      validateSystemPrompt(systemPrompt);
      log.info("System prompt validated — no PII detected");
    }

    // Verify audit log immutability (NIST 800-53 AU-3/AU-6).
    // Non-blocking: log and continue, but a "mutable" result must be
    // alerted on immediately. In production we fail startup.
    if (process.env.NODE_ENV !== "test") {
      try {
        const result = await verifyAuditLogImmutability();
        if (result.status === "mutable") {
          const msg = "Audit log DELETE is permitted — DB permissions are misconfigured";
          if (process.env.NODE_ENV === "production") throw new Error(msg);
          log.error(msg);
        } else if (result.status === "unknown") {
          log.warn("Audit log immutability could not be verified", { message: result.message });
        }
      } catch (err) {
        if (process.env.NODE_ENV === "production") throw err;
        log.warn("Skipping audit immutability check", { error: err.message });
      }
    }

    // Data retention scheduler (NIST 800-53 AU-11). Starts only on the leader
    // replica and only if RETENTION_ENABLED=true. Defaults are fail-closed:
    // disabled, dry-run, leader=false-in-prod. See retentionScheduler.js.
    if (process.env.NODE_ENV !== "test") {
      retentionScheduler.start();
    }

    app.listen(PORT, () => {
      log.info("Server started", {
        port: PORT,
        environment: process.env.NODE_ENV || "development",
        sessionStore: process.env.REDIS_URL ? "redis" : "memory",
      });
    });
  } catch (error) {
    log.error("Startup failed", { error: error.message });
    process.exit(1);
  }
}

startServer();

module.exports = app;
