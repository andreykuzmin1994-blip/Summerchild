const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth, requireRole, generateToken, comparePassword, hashPassword } = require("../middleware/auth");
const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { authLimiter } = require("../middleware/rateLimiter");

const prisma = new PrismaClient();
const router = express.Router();

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
    if (!caseworker) {
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
router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const { riskScore, status } = req.query;
    const where = {
      countyId: req.user.countyId,
      status: status || "COMPLETED",
    };
    if (riskScore) where.riskScore = riskScore;

    const intakes = await prisma.intake.findMany({
      where,
      include: {
        applicant: { select: { displayName: true } },
        _count: { select: { householdMembers: true } },
      },
      orderBy: [
        { expeditedFlag: "desc" }, // Expedited cases first
        { createdAt: "desc" },
      ],
    });

    // Basic stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [todayCount, weekCount, flaggedCount] = await Promise.all([
      prisma.intake.count({ where: { countyId: req.user.countyId, createdAt: { gte: today } } }),
      prisma.intake.count({ where: { countyId: req.user.countyId, createdAt: { gte: weekAgo } } }),
      prisma.intake.count({ where: { countyId: req.user.countyId, riskScore: { in: ["MEDIUM", "HIGH"] } } }),
    ]);

    res.json({
      intakes,
      stats: {
        intakesToday: todayCount,
        intakesThisWeek: weekCount,
        flaggedIntakes: flaggedCount,
      },
    });
  } catch (error) {
    console.error("[DASHBOARD]", error);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

/**
 * GET /api/caseworker/intake/:id
 * Full intake detail with calculations, flags, and conversation log.
 */
router.get("/intake/:id", requireAuth, async (req, res) => {
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

    await logAuditEvent({
      type: EVENTS.CASEWORKER_VIEWED_INTAKE,
      actorType: ACTORS.CASEWORKER,
      actorId: req.user.id,
      intakeId: intake.id,
      countyId: req.user.countyId,
      ip: req.ip,
    });

    res.json(intake);
  } catch (error) {
    console.error("[INTAKE DETAIL]", error);
    res.status(500).json({ error: "Failed to load intake" });
  }
});

/**
 * POST /api/caseworker/intake/:id/review
 * Mark an intake as reviewed with optional correction feedback.
 */
router.post("/intake/:id/review", requireAuth, async (req, res) => {
  try {
    const { correctionsMade, correctionType, notes } = req.body;

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

    await logAuditEvent({
      type: correctionsMade ? EVENTS.CASEWORKER_CORRECTION : EVENTS.CASEWORKER_REVIEWED_INTAKE,
      actorType: ACTORS.CASEWORKER,
      actorId: req.user.id,
      intakeId: intake.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { correctionsMade, correctionType, notes },
    });

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
router.post("/register", requireAuth, requireRole("ADMIN", "SUPERVISOR"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
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
        role: role || "CASEWORKER",
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

module.exports = router;
