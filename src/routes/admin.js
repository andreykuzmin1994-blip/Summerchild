const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireVerifiedAuth, requireRole } = require("../middleware/auth");
const { withRetry } = require("../services/dbRetry");
const { child } = require("../services/logger");

const { statsCache } = require("../services/queryCache");
const { csrfProtection } = require("../middleware/csrfProtection");

const prisma = new PrismaClient();
const router = express.Router();

// CSRF defense — currently admin.js has only GETs, but this future-proofs
// any added mutations (NIST SC-7).
router.use(csrfProtection);
const log = child("admin");

/**
 * GET /api/admin/stats
 * Aggregate statistics for the county (supervisors and admins only).
 */
router.get("/stats", requireVerifiedAuth, requireRole("SUPERVISOR", "ADMIN"), async (req, res) => {
  try {
    const countyId = req.user.countyId;

    const result = await statsCache.getOrCompute(`admin:${countyId}`, async () => {
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

      return {
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
      };
    });

    res.json(result);
  } catch (error) {
    console.error("[ADMIN STATS]", error);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

/**
 * GET /api/admin/audit-log
 * View audit logs (admin only).
 */
router.get("/audit-log", requireVerifiedAuth, requireRole("ADMIN"), async (req, res) => {
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

    // Meta-audit: log who accessed the audit logs
    const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
    await logAuditEvent({
      type: EVENTS.ADMIN_AUDIT_LOG_ACCESSED,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: {
        queryLimit: parseInt(limit),
        queryOffset: parseInt(offset),
        eventTypeFilter: eventType || null,
        resultsReturned: logs.length,
        totalAvailable: total,
      },
    });

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
router.get("/export/intakes", requireVerifiedAuth, requireRole("SUPERVISOR", "ADMIN"), async (req, res) => {
  try {
    const { status, startDate, endDate, page } = req.query;
    const where = { countyId: req.user.countyId };
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Configurable page size with county-appropriate default (5000 per page)
    const PAGE_SIZE = Math.min(parseInt(req.query.pageSize) || 5000, 10000);
    const pageNum = Math.max(1, parseInt(page) || 1);

    // Get total count first so we can warn about truncation
    const totalCount = await withRetry(
      () => prisma.intake.count({ where }),
      { context: "intake.count.export", correlationId: req.correlationId }
    );

    const intakes = await withRetry(
      () => prisma.intake.findMany({
        where,
        select: {
          id: true,
          status: true,
          riskScore: true,
          expeditedFlag: true,
          createdAt: true,
          applicant: { select: { displayName: true } },
          householdMembers: { select: { id: true } },
          incomeSources: { select: { snapMonthlyAmount: true } },
          deductions: { select: { amount: true } },
          shelterExpense: { select: { totalShelterCost: true } },
          reviews: {
            select: {
              reviewedAt: true,
              correctionsMade: true,
              correctionType: true,
              caseworker: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE,
        skip: (pageNum - 1) * PAGE_SIZE,
      }),
      { context: "intake.findMany.export", correlationId: req.correlationId }
    );

    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    const isTruncated = totalCount > PAGE_SIZE;

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
      ...rows.map((row) => row.map((cell) => {
        const str = String(cell).replace(/"/g, '""');
        // Prevent CSV formula injection — prefix with single quote if cell starts with =, +, -, @
        if (/^[=+\-@]/.test(str)) return `"'${str}"`;
        return `"${str}"`;
      }).join(",")),
    ].join("\n");

    const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
    await logAuditEvent({
      type: EVENTS.DATA_EXPORT,
      actorType: ACTORS.ADMIN,
      actorId: req.user.id,
      countyId: req.user.countyId,
      ip: req.ip,
      details: {
        exportType: "intakes_csv",
        recordCount: intakes.length,
        totalRecords: totalCount,
        page: pageNum,
        totalPages,
        truncated: isTruncated,
      },
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="intakes-export-${new Date().toISOString().slice(0, 10)}-page${pageNum}.csv"`);
    // Pagination and truncation metadata headers
    res.setHeader("X-Total-Count", String(totalCount));
    res.setHeader("X-Page", String(pageNum));
    res.setHeader("X-Total-Pages", String(totalPages));
    if (isTruncated) {
      res.setHeader("X-Truncated", "true");
      res.setHeader("X-Truncation-Warning", `Results limited to ${PAGE_SIZE} records per page. Use ?page=N to retrieve additional pages (${totalPages} total).`);
    }
    res.send(csvContent);
  } catch (error) {
    log.error("Export failed", {
      correlationId: req.correlationId,
      error: error.message,
    });
    res.status(500).json({ error: "Failed to export data" });
  }
});

module.exports = router;
