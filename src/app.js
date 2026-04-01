const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const { apiLimiter } = require("./middleware/rateLimiter");
const { validateSystemPrompt } = require("./middleware/systemPromptValidator");
const { buildSystemPrompt } = require("./services/aiAssistant");

const intakeRoutes = require("./routes/intake");
const caseworkerRoutes = require("./routes/caseworker");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 3000;

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

// Rate limiting
app.use("/api", apiLimiter);

// API Routes
app.use("/api/intake", intakeRoutes);
app.use("/api/caseworker", caseworkerRoutes);
app.use("/api/admin", adminRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "sk-ant-...") {
      const systemPrompt = await buildSystemPrompt("GA", 2026);
      validateSystemPrompt(systemPrompt);
      console.log("✓ System prompt validated — no PII detected");
    }

    app.listen(PORT, () => {
      console.log(`Cushion Gov server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("STARTUP FAILED:", error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
