const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const { apiLimiter } = require("./middleware/rateLimiter");
const { ipAllowlistMiddleware } = require("./middleware/ipAllowlist");
const { validateSystemPrompt } = require("./middleware/systemPromptValidator");
const { buildSystemPrompt } = require("./services/aiAssistant");
const { correlationMiddleware, requestLogMiddleware, child } = require("./services/logger");

const intakeRoutes = require("./routes/intake");
const caseworkerRoutes = require("./routes/caseworker");
const adminRoutes = require("./routes/admin");

const log = child("app");
const app = express();
const PORT = process.env.PORT || 3000;

// Correlation ID + structured request logging (CJIS audit trail support)
app.use(correlationMiddleware);
app.use(requestLogMiddleware);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: "10kb" }));

// IP allowlist — restrict access to county network ranges
app.use(ipAllowlistMiddleware);

// Rate limiting
app.use("/api", apiLimiter);

// API Routes
app.use("/api/intake", intakeRoutes);
app.use("/api/caseworker", caseworkerRoutes);
app.use("/api/admin", adminRoutes);

// General health check — DB connectivity, session store, uptime
app.get("/api/health", async (req, res) => {
  const prisma = require("./lib/prisma");
  const { sessionStore } = require("./services/sessionStore");

  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version || "1.0.0",
    checks: {},
  };

  // Database connectivity check
  try {
    await prisma.$queryRaw`SELECT 1`;
    health.checks.database = { status: "ok" };
  } catch {
    health.checks.database = { status: "error", message: "Database connection failed" };
    health.status = "degraded";
  }

  // Session store check
  health.checks.sessions = {
    status: "ok",
    type: process.env.REDIS_URL ? "redis" : "memory",
    activeSessions: sessionStore.size ?? "unknown",
  };

  // Memory usage
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
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
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

    // Validate system prompt contains no PII
    const apiKeyPlaceholder = "sk-ant" + "-...";
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== apiKeyPlaceholder) {
      const systemPrompt = await buildSystemPrompt("GA", 2026);
      validateSystemPrompt(systemPrompt);
      log.info("System prompt validated — no PII detected");
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
