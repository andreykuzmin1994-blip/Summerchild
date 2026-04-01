const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { v4: uuidv4 } = require("uuid");
const { buildSystemPrompt, sendMessage, determineCurrentSection } = require("../services/aiAssistant");
const { PIIStripper } = require("../middleware/piiStripper");
const { injectionGuardMiddleware } = require("../middleware/injectionGuard");
const { validateExtractedData } = require("../services/dataValidator");
const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { calculateFullEligibility } = require("../services/snapCalculator");
const { runConsistencyChecks } = require("../services/consistencyChecker");
const { aiMessageLimiter } = require("../middleware/rateLimiter");

const prisma = new PrismaClient();
const router = express.Router();

// In-memory session store (production: use Redis with TTL)
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(token);
      console.log(`[SESSION CLEANUP] Expired session ${token.slice(0, 8)}...`);
    }
  }
}, 60 * 1000); // Check every minute

/**
 * POST /api/intake/start
 * Start a new intake session. Returns session token and welcome message.
 */
router.post("/start", async (req, res) => {
  try {
    const { countyId, language } = req.body;
    const sessionToken = uuidv4();

    const intake = await prisma.intake.create({
      data: {
        countyId: countyId || "dekalb-ga-001",
        sessionToken,
        status: "IN_PROGRESS",
      },
    });

    // Build system prompt and cache it for this session
    const systemPrompt = await buildSystemPrompt("GA", 2026);

    sessions.set(sessionToken, {
      intakeId: intake.id,
      systemPrompt,
      conversationHistory: [],
      piiStripper: new PIIStripper(),
      turnNumber: 0,
      language: language || "en",
      lastActivity: Date.now(),
    });

    await logAuditEvent({
      type: EVENTS.INTAKE_CREATED,
      actorType: ACTORS.APPLICANT,
      actorId: sessionToken,
      intakeId: intake.id,
      countyId: intake.countyId,
      ip: req.ip,
    });

    // Send initial welcome message
    const welcomeResponse = await sendMessage(
      [],
      systemPrompt,
      "I'm here to apply for SNAP benefits."
    );

    sessions.get(sessionToken).conversationHistory.push(
      { role: "user", content: "I'm here to apply for SNAP benefits." },
      { role: "assistant", content: welcomeResponse.rawMessage }
    );
    sessions.get(sessionToken).turnNumber = 1;

    // Log the conversation turn
    await prisma.conversationLog.createMany({
      data: [
        { intakeId: intake.id, turnNumber: 0, role: "SYSTEM", content: "Intake session started" },
        { intakeId: intake.id, turnNumber: 1, role: "ASSISTANT", content: welcomeResponse.displayMessage },
      ],
    });

    res.json({
      sessionToken,
      intakeId: intake.id,
      message: welcomeResponse.displayMessage,
      section: "WELCOME",
    });
  } catch (error) {
    console.error("[INTAKE START]", error);
    res.status(500).json({ error: "Failed to start intake session" });
  }
});

/**
 * POST /api/intake/message
 * Send a message in an active intake session.
 */
router.post("/message", aiMessageLimiter, injectionGuardMiddleware, async (req, res) => {
  try {
    const { sessionToken, message } = req.body;

    if (!sessionToken || !message) {
      return res.status(400).json({ error: "sessionToken and message are required" });
    }

    const session = sessions.get(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found or expired" });
    }

    // Check session timeout
    if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(sessionToken);
      return res.status(440).json({ error: "Session expired due to inactivity. Please start a new intake." });
    }
    session.lastActivity = Date.now();

    // Verify session matches intake
    const intake = await prisma.intake.findFirst({
      where: { id: session.intakeId, sessionToken },
    });
    if (!intake) {
      return res.status(401).json({ error: "Session mismatch" });
    }

    // Strip PII before sending to AI
    const strippedMessage = session.piiStripper.strip(message);

    // Send to AI
    const aiResponse = await sendMessage(
      session.piiStripper.stripConversation(session.conversationHistory),
      session.systemPrompt,
      strippedMessage
    );

    // Update conversation history
    session.conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: aiResponse.rawMessage }
    );
    session.turnNumber += 1;

    // Validate and process extracted data
    const validatedData = [];
    for (const dataBlock of aiResponse.extractedData) {
      const validation = validateExtractedData(dataBlock);
      if (validation.valid) {
        validatedData.push(dataBlock);
      } else {
        console.warn("[DATA VALIDATION] Rejected:", validation.errors, dataBlock);
      }
    }

    // Log conversation turns
    await prisma.conversationLog.createMany({
      data: [
        { intakeId: intake.id, turnNumber: session.turnNumber * 2 - 1, role: "USER", content: message },
        { intakeId: intake.id, turnNumber: session.turnNumber * 2, role: "ASSISTANT", content: aiResponse.displayMessage },
      ],
    });

    // Log AI API call
    await logAuditEvent({
      type: EVENTS.AI_API_CALL,
      actorType: ACTORS.SYSTEM,
      actorId: sessionToken,
      intakeId: intake.id,
      details: {
        model: aiResponse.model,
        inputTokens: aiResponse.usage?.input_tokens,
        outputTokens: aiResponse.usage?.output_tokens,
      },
    });

    // Restore PII in display message
    const displayMessage = session.piiStripper.restore(aiResponse.displayMessage);
    const section = determineCurrentSection(session.conversationHistory);

    res.json({
      message: displayMessage,
      section,
      extractedData: validatedData,
      model: aiResponse.model,
    });
  } catch (error) {
    console.error("[INTAKE MESSAGE]", error);
    res.status(500).json({ error: "Failed to process message" });
  }
});

/**
 * GET /api/intake/:id/summary
 * Get the full intake summary with calculations and consistency checks.
 */
router.get("/:id/summary", async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionToken } = req.query;

    const intake = await prisma.intake.findFirst({
      where: { id, ...(sessionToken ? { sessionToken } : {}) },
      include: {
        applicant: true,
        householdMembers: true,
        incomeSources: true,
        deductions: true,
        shelterExpense: true,
        documentChecklist: true,
        county: true,
      },
    });

    if (!intake) {
      return res.status(404).json({ error: "Intake not found" });
    }

    // Run full eligibility calculation
    const eligibility = await calculateFullEligibility(intake);

    // Run consistency checks
    const consistency = await runConsistencyChecks(intake, eligibility);

    res.json({
      intake,
      eligibility,
      consistency,
    });
  } catch (error) {
    console.error("[INTAKE SUMMARY]", error);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

/**
 * POST /api/intake/:id/complete
 * Mark an intake as completed. Runs final calculations and consistency checks.
 */
router.post("/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionToken } = req.body;

    const intake = await prisma.intake.findFirst({
      where: { id, sessionToken, status: "IN_PROGRESS" },
      include: {
        applicant: true,
        householdMembers: true,
        incomeSources: true,
        shelterExpense: true,
      },
    });

    if (!intake) {
      return res.status(404).json({ error: "Active intake not found" });
    }

    // Run calculations
    const eligibility = await calculateFullEligibility(intake);
    const consistency = await runConsistencyChecks(intake, eligibility);

    // Update intake with results
    await prisma.intake.update({
      where: { id },
      data: {
        status: "COMPLETED",
        riskScore: consistency.riskScore,
        expeditedFlag: eligibility.expedited.eligible,
        expeditedReason: eligibility.expedited.reasons?.join("; ") || null,
        consistencyFlags: consistency.flags,
      },
    });

    // Save deductions to DB
    for (const ded of eligibility.deductions.deductions) {
      await prisma.deduction.create({
        data: {
          intakeId: id,
          deductionType: ded.type,
          amount: ded.amount,
          calculationNotes: ded.notes,
        },
      });
    }

    await logAuditEvent({
      type: EVENTS.INTAKE_COMPLETED,
      actorType: ACTORS.APPLICANT,
      actorId: sessionToken,
      intakeId: id,
      countyId: intake.countyId,
      ip: req.ip,
    });

    // Clean up session
    sessions.delete(sessionToken);

    res.json({
      status: "COMPLETED",
      riskScore: consistency.riskScore,
      expedited: eligibility.expedited,
      flagCount: consistency.flags.length,
      estimatedBenefit: eligibility.benefitEstimate.estimatedBenefit,
    });
  } catch (error) {
    console.error("[INTAKE COMPLETE]", error);
    res.status(500).json({ error: "Failed to complete intake" });
  }
});

module.exports = router;
