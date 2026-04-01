const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth, requireRole } = require("../middleware/auth");

const prisma = new PrismaClient();
const router = express.Router();

/**
 * GET /api/admin/stats
 * Aggregate statistics for the county (supervisors and admins only).
 */
router.get("/stats", requireAuth, requireRole("SUPERVISOR", "ADMIN"), async (req, res) => {
  try {
    const countyId = req.user.countyId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const [
      totalIntakes,
      completedIntakes,
      reviewedIntakes,
      expeditedCount,
      highRiskCount,
      todayCount,
      weekCount,
      monthCount,
      correctionCount,
    ] = await Promise.all([
      prisma.intake.count({ where: { countyId } }),
      prisma.intake.count({ where: { countyId, status: "COMPLETED" } }),
      prisma.intake.count({ where: { countyId, status: "REVIEWED" } }),
      prisma.intake.count({ where: { countyId, expeditedFlag: true } }),
      prisma.intake.count({ where: { countyId, riskScore: "HIGH" } }),
      prisma.intake.count({ where: { countyId, createdAt: { gte: today } } }),
      prisma.intake.count({ where: { countyId, createdAt: { gte: weekAgo } } }),
      prisma.intake.count({ where: { countyId, createdAt: { gte: monthAgo } } }),
      prisma.intakeReview.count({ where: { caseworker: { countyId }, correctionsMade: true } }),
    ]);

    const completionRate = totalIntakes > 0
      ? ((completedIntakes + reviewedIntakes) / totalIntakes * 100).toFixed(1)
      : 0;

    const correctionRate = (completedIntakes + reviewedIntakes) > 0
      ? (correctionCount / (completedIntakes + reviewedIntakes) * 100).toFixed(1)
      : 0;

    res.json({
      totalIntakes,
      completedIntakes,
      reviewedIntakes,
      expeditedCount,
      highRiskCount,
      intakesToday: todayCount,
      intakesThisWeek: weekCount,
      intakesThisMonth: monthCount,
      completionRate: `${completionRate}%`,
      correctionRate: `${correctionRate}%`,
    });
  } catch (error) {
    console.error("[ADMIN STATS]", error);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

/**
 * GET /api/admin/audit-log
 * View audit logs (admin only).
 */
router.get("/audit-log", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { limit = 100, offset = 0, eventType } = req.query;
    const where = { countyId: req.user.countyId };
    if (eventType) where.eventType = eventType;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    const total = await prisma.auditLog.count({ where });

    res.json({ logs, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error("[AUDIT LOG]", error);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

module.exports = router;
