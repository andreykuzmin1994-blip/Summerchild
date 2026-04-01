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
      take: Math.min(parseInt(limit) || 100, 1000),
      skip: parseInt(offset) || 0,
    });

    const total = await prisma.auditLog.count({ where });

    res.json({ logs, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error("[AUDIT LOG]", error);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

/**
 * GET /api/admin/export/intakes
 * Export intakes as CSV for reporting (supervisors and admins).
 */
router.get("/export/intakes", requireAuth, requireRole("SUPERVISOR", "ADMIN"), async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    const where = { countyId: req.user.countyId };
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const intakes = await prisma.intake.findMany({
      where,
      include: {
        applicant: true,
        householdMembers: true,
        incomeSources: true,
        deductions: true,
        shelterExpense: true,
        reviews: { include: { caseworker: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });

    // Build CSV
    const headers = [
      "Intake ID", "Status", "Risk Score", "Expedited", "Created At",
      "Applicant Display Name",
      "Household Size", "Gross Monthly Income", "Total Deductions", "Net Income",
      "Shelter Cost", "Reviewed By", "Reviewed At", "Corrections Made", "Correction Type",
    ];

    const rows = intakes.map((i) => {
      const gross = i.incomeSources?.reduce((s, src) => s + (src.snapMonthlyAmount || 0), 0) || 0;
      const totalDed = i.deductions?.reduce((s, d) => s + d.amount, 0) || 0;
      const lastReview = i.reviews?.[i.reviews.length - 1];
      return [
        i.id,
        i.status,
        i.riskScore || "",
        i.expeditedFlag ? "Yes" : "No",
        i.createdAt?.toISOString(),
        i.applicant?.displayName || "",
        (i.householdMembers?.length || 0) + 1,
        gross.toFixed(2),
        totalDed.toFixed(2),
        Math.max(0, gross - totalDed).toFixed(2),
        i.shelterExpense?.totalShelterCost || "",
        lastReview?.caseworker?.name || "",
        lastReview?.reviewedAt?.toISOString() || "",
        lastReview?.correctionsMade ? "Yes" : "No",
        lastReview?.correctionType || "",
      ];
    });

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
    await logAuditEvent({
      type: EVENTS.DATA_EXPORT,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: { exportType: "intakes_csv", recordCount: intakes.length },
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="intakes-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvContent);
  } catch (error) {
    console.error("[EXPORT]", error);
    res.status(500).json({ error: "Failed to export data" });
  }
});

module.exports = router;
