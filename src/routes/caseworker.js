const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireVerifiedAuth, requireRole, generateToken, comparePassword, hashPassword } = require("../middleware/auth");
const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { authLimiter } = require("../middleware/rateLimiter");
const { calculateFullEligibility } = require("../services/snapCalculator");
const { eligibilityCache, statsCache } = require("../services/queryCache");
const { refreshErrorPatterns, getAccuracyStats } = require("../services/errorPredictor");
const { buildAuthCookieOptions } = require("../lib/cookies");
const { csrfProtection } = require("../middleware/csrfProtection");
const { safeDecrypt } = require("../lib/fieldCrypto");

const prisma = new PrismaClient();
const router = express.Router();

// CSRF defense-in-depth for cookie-authenticated mutations (NIST SC-7).
// Login is exempt — the client has no cookie yet; authLimiter already gates it.
router.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/login") return next();
  return csrfProtection(req, res, next);
});

function validatePasswordComplexity(password) {
  if (!password || password.length < 12) return "Password must be at least 12 characters";
  if (password.length > 128) return "Password must not exceed 128 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain at least one digit";
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) return "Password must contain at least one special character";
  // Block common weak passwords
  const lower = password.toLowerCase();
  const weak = ["password1234", "admin1234567", "changeme1234", "qwerty123456"];
  if (weak.some((w) => lower.includes(w))) return "Password is too common — please choose a stronger one";
  return null;
}

// Roles that may be assigned via /register and PUT /users/:id.
// Keep in sync with CaseworkerRole enum in prisma/schema.prisma.
const ASSIGNABLE_ROLES = ["CASEWORKER", "SUPERVISOR", "ADMIN", "AUDITOR"];

// NIST AC-5 (Separation of Duties): caps what each actor role may ASSIGN.
// A SUPERVISOR may only create front-line CASEWORKER accounts. Only an ADMIN
// can mint privileged accounts (ADMIN, SUPERVISOR, AUDITOR). This closes a
// privilege-escalation path where a SUPERVISOR could register a shadow ADMIN.
function rolesActorMayAssign(actorRole) {
  if (actorRole === "ADMIN") return ASSIGNABLE_ROLES;
  if (actorRole === "SUPERVISOR") return ["CASEWORKER"];
  return [];
}

/**
 * POST /api/caseworker/login
 */
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const caseworker = await prisma.caseworker.findUnique({ where: { email } });
    if (!caseworker || caseworker.deactivatedAt) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await comparePassword(password, caseworker.password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = generateToken(caseworker);

    await logAuditEvent({
      type: EVENTS.CASEWORKER_LOGIN,
      actorType: ACTORS.CASEWORKER,
      actorId: caseworker.id,
      countyId: caseworker.countyId,
      ip: req.ip,
    });

    // Set JWT as httpOnly cookie (XSS-safe — not accessible via JavaScript).
    // Secure flag is on by default; see src/lib/cookies.js for policy.
    res.cookie("token", token, buildAuthCookieOptions({
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    }));

    res.json({
      token,
      caseworker: {
        id: caseworker.id,
        name: caseworker.name,
        email: caseworker.email,
        role: caseworker.role,
      },
    });
  } catch (error) {
    console.error("[CASEWORKER LOGIN]", error);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * GET /api/caseworker/dashboard
 * Queue view: list of completed intakes for the caseworker's county.
 */
router.get("/dashboard", requireVerifiedAuth, async (req, res) => {
  try {
    const { riskScore, status, requiresReview } = req.query;
    const where = {
      countyId: req.user.countyId,
      status: status || "COMPLETED",
    };
    if (riskScore) where.riskScore = riskScore;
    if (requiresReview === "true") where.requiresReview = true;

    const intakes = await prisma.intake.findMany({
      where,
      select: {
        id: true,
        status: true,
        queueNumber: true,
        riskScore: true,
        predictiveScore: true,
        requiresReview: true,
        expeditedFlag: true,
        createdAt: true,
        updatedAt: true,
        applicant: { select: { displayName: true } },
        _count: { select: { householdMembers: true } },
      },
      orderBy: [
        { expeditedFlag: "desc" },      // Expedited cases first
        { requiresReview: "desc" },      // Then cases needing review
        { predictiveScore: "desc" },     // Then by predictive risk (highest first)
        { createdAt: "desc" },
      ],
    });

    // Dashboard stats — cached per county for 2 minutes to avoid repeated count queries
    const countyId = req.user.countyId;
    const stats = await statsCache.getOrCompute(`dashboard:${countyId}`, async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const completedWhere = { countyId, status: { in: ["COMPLETED", "REVIEWED"] } };

      const [todayCount, weekCount, flaggedCount, totalCompleted, flaggedCompleted] = await Promise.all([
        prisma.intake.count({ where: { countyId, createdAt: { gte: today } } }),
        prisma.intake.count({ where: { countyId, createdAt: { gte: weekAgo } } }),
        prisma.intake.count({ where: { countyId, riskScore: { in: ["MEDIUM", "HIGH"] } } }),
        prisma.intake.count({ where: completedWhere }),
        prisma.intake.count({ where: { ...completedWhere, riskScore: { in: ["MEDIUM", "HIGH"] } } }),
      ]);

      // Use raw SQL aggregation instead of fetching 500 rows to compute average
      const avgResult = await prisma.$queryRaw`
        SELECT COALESCE(
          ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60)),
          0
        )::int AS avg_minutes
        FROM intakes
        WHERE county_id = ${countyId}
          AND status IN ('COMPLETED', 'REVIEWED')
      `;
      const avgCompletionTime = avgResult[0]?.avg_minutes || 0;

      const flagRate = totalCompleted > 0
        ? `${(flaggedCompleted / totalCompleted * 100).toFixed(1)}%`
        : "0%";

      // Accuracy Assistant stats
      const requiresReviewCount = await prisma.intake.count({
        where: { countyId, requiresReview: true, status: { in: ["COMPLETED"] } },
      });

      return {
        intakesToday: todayCount,
        intakesThisWeek: weekCount,
        flaggedIntakes: flaggedCount,
        avgCompletionTimeMinutes: avgCompletionTime,
        flagRate,
        requiresReviewCount,
      };
    });

    res.json({ intakes, stats });
  } catch (error) {
    console.error("[DASHBOARD]", error);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

/**
 * GET /api/caseworker/intake/:id
 * Full intake detail with calculations, flags, and conversation log.
 */
router.get("/intake/:id", requireVerifiedAuth, async (req, res) => {
  try {
    const intake = await prisma.intake.findFirst({
      where: {
        id: req.params.id,
        countyId: req.user.countyId, // Always scoped to county
      },
      include: {
        applicant: true,
        householdMembers: true,
        incomeSources: { include: { householdMember: true } },
        deductions: true,
        shelterExpense: true,
        documentChecklist: true,
        conversationLogs: { orderBy: { turnNumber: "asc" } },
        reviews: { include: { caseworker: { select: { name: true } } } },
        county: true,
      },
    });

    if (!intake) {
      return res.status(404).json({ error: "Intake not found" });
    }

    // NIST SC-28: decrypt ConversationLog.content for caseworker display.
    // Legacy (pre-encryption) rows pass through unchanged. Decrypt failures
    // are surfaced as a sentinel string and recorded in the audit log — the
    // caseworker sees "[decryption error — logged for investigation]" on
    // that single turn, not a broken page.
    if (Array.isArray(intake.conversationLogs)) {
      for (const log of intake.conversationLogs) {
        log.content = safeDecrypt(log.content, intake.id, (info) => {
          logAuditEvent({
            type: "CONVERSATION_DECRYPT_FAILED",
            actorType: ACTORS.SYSTEM,
            actorId: "field-crypto",
            intakeId: intake.id,
            countyId: req.user.countyId,
            details: { logId: log.id, errorName: info.name },
          }).catch(() => {});
        });
      }
    }

    // Run eligibility calculations for the output packet (cached by intake version)
    let eligibility = null;
    if (intake.status !== "IN_PROGRESS") {
      try {
        const cacheKey = `elig:${intake.id}:${intake.updatedAt.getTime()}`;
        eligibility = await eligibilityCache.getOrCompute(cacheKey, () =>
          calculateFullEligibility(intake)
        );
      } catch (err) {
        console.error("[ELIGIBILITY CALC]", err);
      }
    }

    // Build audit trail stats
    const conversationCount = intake.conversationLogs?.filter((l) => l.role === "USER").length || 0;
    const auditTrail = {
      intakeStarted: intake.createdAt,
      intakeCompleted: intake.updatedAt,
      durationMinutes: Math.round((new Date(intake.updatedAt) - new Date(intake.createdAt)) / 60000),
      questionsAsked: intake.conversationLogs?.filter((l) => l.role === "ASSISTANT").length || 0,
      userResponses: conversationCount,
      flagsGenerated: Array.isArray(intake.consistencyFlags) ? intake.consistencyFlags.length : 0,
      applicantConfirmedSummary: intake.status !== "IN_PROGRESS",
    };

    await logAuditEvent({
      type: EVENTS.CASEWORKER_VIEWED_INTAKE,
      actorType: ACTORS.CASEWORKER,
      actorId: req.user.id,
      intakeId: intake.id,
      countyId: req.user.countyId,
      ip: req.ip,
    });

    // Restrict raw conversation logs to SUPERVISOR and ADMIN roles
    const result = { ...intake, eligibility, auditTrail };
    if (req.user.role === "CASEWORKER") {
      result.conversationLogs = undefined;
    }

    res.json(result);
  } catch (error) {
    console.error("[INTAKE DETAIL]", error);
    res.status(500).json({ error: "Failed to load intake" });
  }
});

/**
 * POST /api/caseworker/intake/:id/review
 * Mark an intake as reviewed with optional correction feedback.
 */
router.post("/intake/:id/review", requireVerifiedAuth, async (req, res) => {
  try {
    const { correctionsMade, correctionType, correctionDetails, notes, reviewerConfirmsAllData } = req.body;

    // Mandatory review confirmation — caseworker must explicitly confirm review
    if (!reviewerConfirmsAllData) {
      return res.status(400).json({
        error: "Must confirm review of all extracted data before finalizing",
        requiresConfirmation: true,
        hint: "Set reviewerConfirmsAllData: true to confirm you have reviewed all intake data",
      });
    }

    const intake = await prisma.intake.findFirst({
      where: { id: req.params.id, countyId: req.user.countyId },
    });

    if (!intake) {
      return res.status(404).json({ error: "Intake not found" });
    }

    const review = await prisma.intakeReview.create({
      data: {
        intakeId: intake.id,
        caseworkerId: req.user.id,
        correctionsMade: correctionsMade || false,
        correctionType: correctionType || null,
        notes: notes || null,
      },
    });

    await prisma.intake.update({
      where: { id: intake.id },
      data: {
        status: "REVIEWED",
        caseworkerId: req.user.id,
      },
    });

    // Detailed audit trail with before/after values for corrections
    await logAuditEvent({
      type: EVENTS.CASEWORKER_REVIEW_CONFIRMED,
      actorType: ACTORS.CASEWORKER,
      actorId: req.user.id,
      intakeId: intake.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: {
        reviewerConfirmed: true,
        correctionsMade: correctionsMade || false,
        correctionType: correctionType || null,
        correctionDetails: correctionDetails || null,
        notes: notes || null,
        timestamp: new Date().toISOString(),
      },
    });

    if (correctionsMade) {
      await logAuditEvent({
        type: EVENTS.CASEWORKER_CORRECTION,
        actorType: ACTORS.CASEWORKER,
        actorId: req.user.id,
        intakeId: intake.id,
        countyId: req.user.countyId,
        ip: req.ip,
        details: {
          correctionType,
          correctionDetails: correctionDetails || null,
          notes,
        },
      });
    }

    res.json({ review, status: "REVIEWED" });
  } catch (error) {
    console.error("[INTAKE REVIEW]", error);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/**
 * POST /api/caseworker/register
 * Register a new caseworker (admin only).
 */
router.post("/register", requireVerifiedAuth, requireRole("ADMIN", "SUPERVISOR"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    // Role-assignment SoD: validate the requested role is within the actor's
    // authority. SUPERVISOR can only create CASEWORKERs; only ADMIN can mint
    // privileged accounts (NIST AC-5).
    const requestedRole = role || "CASEWORKER";
    const allowed = rolesActorMayAssign(req.user.role);
    if (!allowed.includes(requestedRole)) {
      return res.status(403).json({
        error: `Your role (${req.user.role}) may only create accounts with role(s): ${allowed.join(", ")}`,
      });
    }

    const passwordError = validatePasswordComplexity(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const existing = await prisma.caseworker.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hashed = await hashPassword(password);
    const caseworker = await prisma.caseworker.create({
      data: {
        countyId: req.user.countyId,
        name,
        email,
        password: hashed,
        role: requestedRole,
      },
    });

    await logAuditEvent({
      type: EVENTS.ADMIN_USER_CREATED,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { newUserId: caseworker.id, newUserEmail: email, role: caseworker.role },
    });

    res.status(201).json({
      id: caseworker.id,
      name: caseworker.name,
      email: caseworker.email,
      role: caseworker.role,
    });
  } catch (error) {
    console.error("[REGISTER]", error);
    res.status(500).json({ error: "Failed to register caseworker" });
  }
});

/**
 * GET /api/caseworker/users
 * List all caseworkers for the county (admin/supervisor only).
 */
router.get("/users", requireVerifiedAuth, requireRole("ADMIN", "SUPERVISOR"), async (req, res) => {
  try {
    const caseworkers = await prisma.caseworker.findMany({
      where: { countyId: req.user.countyId, deactivatedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        _count: { select: { reviews: true, intakes: true } },
      },
      orderBy: { name: "asc" },
    });

    res.json(caseworkers);
  } catch (error) {
    console.error("[LIST USERS]", error);
    res.status(500).json({ error: "Failed to load users" });
  }
});

/**
 * PUT /api/caseworker/users/:id
 * Update a caseworker's role (admin only).
 */
router.put("/users/:id", requireVerifiedAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || !ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: "Valid role is required" });
    }

    // NIST AC-5: an admin may not change their own role. This blocks
    // self-promotion/self-demotion used to obscure other actions. Role
    // changes to one's own account must be performed by a different admin.
    if (req.params.id === req.user.id) {
      return res.status(403).json({
        error: "Admins cannot change their own role. Another admin must perform this action.",
      });
    }

    const target = await prisma.caseworker.findFirst({
      where: { id: req.params.id, countyId: req.user.countyId },
    });
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    const updated = await prisma.caseworker.update({
      where: { id: req.params.id },
      data: { role },
    });

    await logAuditEvent({
      type: EVENTS.ADMIN_USER_MODIFIED,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { targetUserId: target.id, oldRole: target.role, newRole: role },
    });

    res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role });
  } catch (error) {
    console.error("[UPDATE USER]", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * POST /api/caseworker/users/:id/reset-password
 * Admin resets a caseworker's password.
 */
router.post("/users/:id/reset-password", requireVerifiedAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const passwordError = validatePasswordComplexity(newPassword);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const target = await prisma.caseworker.findFirst({
      where: { id: req.params.id, countyId: req.user.countyId },
    });
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    const hashed = await hashPassword(newPassword);
    await prisma.caseworker.update({
      where: { id: req.params.id },
      data: { password: hashed },
    });

    await logAuditEvent({
      type: EVENTS.ADMIN_USER_MODIFIED,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { targetUserId: target.id, action: "password_reset" },
    });

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("[RESET PASSWORD]", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

/**
 * DELETE /api/caseworker/users/:id
 * Deactivate a caseworker (admin only). Soft-delete approach.
 */
router.delete("/users/:id", requireVerifiedAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Cannot deactivate your own account" });
    }

    const target = await prisma.caseworker.findFirst({
      where: { id: req.params.id, countyId: req.user.countyId },
    });
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.caseworker.update({
      where: { id: req.params.id },
      data: { deactivatedAt: new Date() },
    });

    await logAuditEvent({
      type: EVENTS.ADMIN_USER_DEACTIVATED,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { targetUserId: target.id, targetEmail: target.email },
    });

    res.json({ message: "User deactivated" });
  } catch (error) {
    console.error("[DEACTIVATE USER]", error);
    res.status(500).json({ error: "Failed to deactivate user" });
  }
});

// ─── Accuracy Assistant Endpoints ─────────────────────────────────

/**
 * GET /api/caseworker/accuracy/stats
 * Accuracy statistics for the caseworker's county.
 */
router.get("/accuracy/stats", requireAuth, async (req, res) => {
  try {
    const stats = await getAccuracyStats(req.user.countyId);
    res.json(stats);
  } catch (error) {
    console.error("[ACCURACY STATS]", error);
    res.status(500).json({ error: "Failed to load accuracy stats" });
  }
});

/**
 * GET /api/caseworker/accuracy/patterns
 * View cached error patterns for the caseworker's state.
 */
router.get("/accuracy/patterns", requireAuth, async (req, res) => {
  try {
    const county = await prisma.county.findUnique({
      where: { id: req.user.countyId },
    });
    if (!county) {
      return res.status(404).json({ error: "County not found" });
    }

    const patterns = await prisma.errorPattern.findMany({
      where: { stateCode: county.stateCode },
      orderBy: [{ errorRate: "desc" }],
    });

    res.json({ stateCode: county.stateCode, patterns });
  } catch (error) {
    console.error("[ACCURACY PATTERNS]", error);
    res.status(500).json({ error: "Failed to load error patterns" });
  }
});

/**
 * POST /api/caseworker/accuracy/refresh-patterns
 * Refresh error patterns from historical data (supervisor/admin only).
 */
router.post(
  "/accuracy/refresh-patterns",
  requireAuth,
  requireRole("ADMIN", "SUPERVISOR"),
  async (req, res) => {
    try {
      const county = await prisma.county.findUnique({
        where: { id: req.user.countyId },
      });
      if (!county) {
        return res.status(404).json({ error: "County not found" });
      }

      const patterns = await refreshErrorPatterns(county.stateCode);

      await logAuditEvent({
        type: "ACCURACY_PATTERNS_REFRESHED",
        actorType: ACTORS.CASEWORKER,
        actorId: req.user.id,
        countyId: req.user.countyId,
        ip: req.ip,
        details: { stateCode: county.stateCode, patternsGenerated: patterns.length },
      });

      res.json({
        message: "Error patterns refreshed",
        stateCode: county.stateCode,
        patternsGenerated: patterns.length,
        patterns,
      });
    } catch (error) {
      console.error("[REFRESH PATTERNS]", error);
      res.status(500).json({ error: "Failed to refresh error patterns" });
    }
  }
);

/**
 * GET /api/caseworker/accuracy/review-queue
 * Cases flagged by Accuracy Assistant for mandatory review.
 * Prioritized by predictive score (highest risk first).
 */
router.get("/accuracy/review-queue", requireAuth, async (req, res) => {
  try {
    const intakes = await prisma.intake.findMany({
      where: {
        countyId: req.user.countyId,
        requiresReview: true,
        status: "COMPLETED",
      },
      select: {
        id: true,
        queueNumber: true,
        riskScore: true,
        predictiveScore: true,
        riskFactors: true,
        expeditedFlag: true,
        createdAt: true,
        applicant: { select: { displayName: true } },
        _count: { select: { householdMembers: true } },
      },
      orderBy: [
        { expeditedFlag: "desc" },
        { predictiveScore: "desc" },
      ],
    });

    // Attach human-readable summaries
    const enriched = intakes.map((intake) => ({
      ...intake,
      riskSummary: intake.predictiveScore >= 70
        ? `High error risk (${intake.predictiveScore}/100) — mandatory review`
        : `Moderate error risk (${intake.predictiveScore}/100) — review recommended`,
      topRiskFactors: Array.isArray(intake.riskFactors)
        ? intake.riskFactors
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((f) => f.detail || f.description)
        : [],
    }));

    res.json({
      count: enriched.length,
      intakes: enriched,
    });
  } catch (error) {
    console.error("[REVIEW QUEUE]", error);
    res.status(500).json({ error: "Failed to load review queue" });
  }
});

module.exports = router;
