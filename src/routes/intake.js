const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { v4: uuidv4 } = require("uuid");
const { buildSystemPromptWithContext, sendMessage, determineCurrentSection } = require("../services/aiAssistant");
const { PIIStripper } = require("../middleware/piiStripper");
const { injectionGuardMiddleware } = require("../middleware/injectionGuard");
const { validateExtractedData, validateDisplayName } = require("../services/dataValidator");
const { validateAIResponse } = require("../services/aiResponseValidator");
const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { calculateFullEligibility } = require("../services/snapCalculator");
const { runConsistencyChecks } = require("../services/consistencyChecker");
const { aiMessageLimiter, intakeStartLimiter } = require("../middleware/rateLimiter");
const { requireStaffPin } = require("../middleware/kioskAuth");
const { sessionStore, SESSION_TTL_MS } = require("../services/sessionStore");
const { withRetry } = require("../services/dbRetry");
const { child } = require("../services/logger");
const {
  sanitizeForDisplay,
  validateDataBlockCount,
  sanitizeAIResponse,
  scanOutputForPII,
  blockExfiltration,
} = require("../middleware/outputSanitizer");
const { validateConversationContext } = require("../middleware/conversationContext");
const { runOutputGuardrails, BLOCKED_RESPONSE } = require("../middleware/outputGuardrails");
const { DialogRailEngine, checkRetrievalRail } = require("../services/dialogRails");

const { getStandardUtilityAllowance, calculateMonthlyIncome, FREQUENCY_MULTIPLIERS } = require("../services/snapCalculator");

// Maximum conversation turns per intake session to prevent AI cost abuse.
// A normal SNAP intake requires ~20 turns. 50 provides generous headroom.
const MAX_CONVERSATION_TURNS = parseInt(process.env.MAX_CONVERSATION_TURNS || "50", 10);

// Per-session token budget: max total tokens (input + output) consumed per session.
// A typical SNAP intake uses ~15K input + 5K output tokens. 200K provides generous headroom
// while still capping abuse from adversarial long conversations.
const MAX_SESSION_TOKENS = parseInt(process.env.MAX_SESSION_TOKENS || "200000", 10);

const prisma = new PrismaClient();
const router = express.Router();
const log = child("intake");

// Queue number counter (resets daily in production; in-memory for demo)
let queueCounter = 0;
function generateQueueNumber() {
  queueCounter += 1;
  const letter = String.fromCharCode(65 + Math.floor((queueCounter - 1) / 100)); // A, B, C...
  const num = String(((queueCounter - 1) % 100) + 1).padStart(4, "0");
  return `${letter}-${num}`;
}

/**
 * Persist a validated extracted data block to the database.
 * Maps AI-extracted field names to Prisma model creates/upserts.
 */
async function persistExtractedData(intakeId, dataBlock) {
  const field = dataBlock.field;

  switch (field) {
    case "applicant_info":
    case "applicant_language": {
      // Only update language preference — no PII collected
      const existing = await prisma.applicant.findUnique({ where: { intakeId } });
      if (existing && dataBlock.language) {
        await prisma.applicant.update({
          where: { intakeId },
          data: { languagePreference: dataBlock.language },
        });
      }
      break;
    }

    case "household_member": {
      const isElderly = dataBlock.is_elderly || (dataBlock.age_range === "60+" || dataBlock.age_range === "60-69" || dataBlock.age_range === "70+");
      // Purchase-and-prepare determines SNAP household membership
      // Spouses and children under 22 are always in the SNAP household
      const relationship = (dataBlock.relationship || "").toLowerCase();
      const isSpouseOrYoungChild =
        relationship === "spouse" ||
        (["child", "son", "daughter", "son/daughter"].includes(relationship) &&
          dataBlock.age_range && (dataBlock.age_range.startsWith("0-") || dataBlock.age_range === "under 18"));
      const purchasesAndPrepares = dataBlock.purchases_and_prepares_together !== undefined
        ? dataBlock.purchases_and_prepares_together
        : true;
      const inSnapHousehold = purchasesAndPrepares || isSpouseOrYoungChild;

      await prisma.householdMember.create({
        data: {
          intakeId,
          displayName: dataBlock.display_name || `Member`,
          ageRange: dataBlock.age_range || null,
          relationshipToApplicant: dataBlock.relationship || "",
          purchasesAndPreparesTogether: purchasesAndPrepares,
          inSnapHousehold,
          isElderly,
          isDisabled: dataBlock.is_disabled || false,
          hasEarnedIncome: false,
          hasUnearnedIncome: false,
        },
      });
      break;
    }

    case "income_source": {
      const payFrequency = (dataBlock.pay_frequency || "MONTHLY").toUpperCase();
      const grossAmount = dataBlock.gross_per_period || 0;
      const incomeType = (dataBlock.income_type || "EMPLOYMENT").toUpperCase();
      const isEmployment = incomeType === "EMPLOYMENT" || incomeType === "SELF_EMPLOYMENT";

      // Calculate SNAP monthly amount
      let snapMonthly;
      if (incomeType === "SELF_EMPLOYMENT") {
        snapMonthly = calculateMonthlyIncome({
          incomeType,
          grossAmountPerPeriod: grossAmount,
          selfEmploymentGross: dataBlock.self_employment_gross || grossAmount,
          selfEmploymentExpenses: dataBlock.self_employment_expenses || 0,
        });
      } else {
        const multiplier = FREQUENCY_MULTIPLIERS[payFrequency] || 1;
        snapMonthly = Math.round(grossAmount * multiplier * 100) / 100;
      }

      // Find the household member this income belongs to
      let memberId = null;
      if (dataBlock.member && dataBlock.member !== "applicant") {
        const members = await prisma.householdMember.findMany({ where: { intakeId } });
        const match = members.find((m) =>
          m.displayName.toLowerCase() === (dataBlock.member || "").toLowerCase()
        );
        if (match) memberId = match.id;
      }

      await prisma.incomeSource.create({
        data: {
          intakeId,
          householdMemberId: memberId,
          incomeType,
          employerOrPayerName: dataBlock.employer || null,
          payFrequency,
          grossAmountPerPeriod: grossAmount,
          snapMonthlyAmount: snapMonthly,
          selfEmploymentGross: dataBlock.self_employment_gross || null,
          selfEmploymentExpenses: dataBlock.self_employment_expenses || null,
          selfEmploymentDeductionMethod: dataBlock.self_employment_deduction_method || null,
          selfEmploymentNet: incomeType === "SELF_EMPLOYMENT" ? snapMonthly : null,
        },
      });

      // Update household member earned/unearned income flags
      if (memberId) {
        await prisma.householdMember.update({
          where: { id: memberId },
          data: isEmployment ? { hasEarnedIncome: true } : { hasUnearnedIncome: true },
        });
      }
      break;
    }

    case "shelter_expense":
    case "shelter_rent":
    case "shelter_utility": {
      const existing = await prisma.shelterExpense.findUnique({ where: { intakeId } });
      const updates = {};

      if (field === "shelter_rent" || dataBlock.rent !== undefined) {
        updates.rentOrMortgage = dataBlock.rent || dataBlock.value || 0;
      }
      if (dataBlock.property_tax !== undefined) {
        updates.propertyTax = dataBlock.property_tax;
      }
      if (dataBlock.homeowners_insurance !== undefined) {
        updates.homeownersInsurance = dataBlock.homeowners_insurance;
      }
      if (field === "shelter_utility" || dataBlock.utility_type !== undefined) {
        const utilityType = (dataBlock.utility_type || dataBlock.value || "NONE").toUpperCase();
        updates.utilityType = utilityType;
        updates.standardUtilityAllowance = getStandardUtilityAllowance(utilityType);
      }

      if (existing) {
        const merged = { ...existing, ...updates };
        merged.totalShelterCost =
          (merged.rentOrMortgage || 0) +
          (merged.propertyTax || 0) +
          (merged.homeownersInsurance || 0) +
          (merged.standardUtilityAllowance || 0);
        await prisma.shelterExpense.update({ where: { intakeId }, data: { ...updates, totalShelterCost: merged.totalShelterCost } });
      } else {
        const sua = updates.standardUtilityAllowance || 0;
        const rent = updates.rentOrMortgage || 0;
        const tax = updates.propertyTax || 0;
        const ins = updates.homeownersInsurance || 0;
        await prisma.shelterExpense.create({
          data: {
            intakeId,
            rentOrMortgage: rent,
            propertyTax: tax,
            homeownersInsurance: ins,
            utilityType: updates.utilityType || "NONE",
            standardUtilityAllowance: sua,
            totalShelterCost: rent + tax + ins + sua,
          },
        });
      }
      break;
    }

    case "dependent_care": {
      const amount = parseFloat(dataBlock.value) || 0;
      if (amount > 0) {
        await prisma.intake.update({
          where: { id: intakeId },
          data: { dependentCareExpense: amount },
        });
      }
      break;
    }

    case "medical_expenses": {
      const amount = parseFloat(dataBlock.value) || 0;
      if (amount > 0) {
        await prisma.intake.update({
          where: { id: intakeId },
          data: { medicalExpenses: amount },
        });
      }
      break;
    }

    case "child_support_paid": {
      const amount = parseFloat(dataBlock.value) || 0;
      if (amount > 0) {
        await prisma.intake.update({
          where: { id: intakeId },
          data: { childSupportPaid: amount },
        });
      }
      break;
    }

    case "liquid_resources": {
      const amount = parseFloat(dataBlock.value) || 0;
      await prisma.intake.update({
        where: { id: intakeId },
        data: { liquidResources: amount },
      });
      break;
    }

    default:
      // Unknown field — log but don't crash
      console.warn(`[PERSIST] Unknown field type: ${field}`);
  }
}

/**
 * Generate a personalized document checklist based on intake data
 * using the rules defined in gateway-snap-fields.json.
 */
async function generateDocumentChecklist(intakeId) {
  const intake = await prisma.intake.findUnique({
    where: { id: intakeId },
    include: {
      applicant: true,
      householdMembers: true,
      incomeSources: { include: { householdMember: true } },
      shelterExpense: true,
    },
  });

  if (!intake) return;

  const docs = [];

  // Always required: Photo ID
  docs.push({
    intakeId,
    documentType: "Photo ID",
    description: "Valid government-issued photo ID for the applicant",
    required: true,
  });

  // Income-based documents
  for (const source of intake.incomeSources || []) {
    const memberName = source.householdMember
      ? source.householdMember.displayName
      : intake.applicant
        ? intake.applicant.displayName
        : "Applicant";

    switch (source.incomeType) {
      case "EMPLOYMENT":
        docs.push({
          intakeId,
          documentType: `Pay stubs - ${memberName}`,
          description: `Last 4 pay stubs from ${source.employerOrPayerName || "employer"} (${source.payFrequency.toLowerCase()})`,
          required: true,
        });
        break;
      case "SELF_EMPLOYMENT":
        docs.push({
          intakeId,
          documentType: `Self-employment records - ${memberName}`,
          description: "Business income and expense records for the last 12 months",
          required: true,
        });
        break;
      case "SOCIAL_SECURITY":
      case "SSI":
      case "SSDI":
        docs.push({
          intakeId,
          documentType: `Social Security documentation - ${memberName}`,
          description: "Most recent Social Security award letter or bank statement showing deposit",
          required: true,
        });
        break;
      case "UNEMPLOYMENT":
        docs.push({
          intakeId,
          documentType: `Unemployment documentation - ${memberName}`,
          description: "Unemployment compensation determination letter",
          required: true,
        });
        break;
      case "VA_BENEFITS":
        docs.push({
          intakeId,
          documentType: `VA benefits letter - ${memberName}`,
          description: "Veterans Administration benefits award letter",
          required: true,
        });
        break;
      case "PENSION":
        docs.push({
          intakeId,
          documentType: `Pension statement - ${memberName}`,
          description: "Most recent pension or retirement account statement",
          required: true,
        });
        break;
    }
  }

  // Shelter documents
  const shelter = intake.shelterExpense;
  if (shelter && shelter.rentOrMortgage > 0) {
    docs.push({
      intakeId,
      documentType: "Lease or mortgage statement",
      description: "Current lease agreement, rental receipt, or mortgage statement",
      required: true,
    });
  }
  if (shelter && shelter.utilityType && shelter.utilityType !== "NONE") {
    docs.push({
      intakeId,
      documentType: "Utility bill",
      description: "Most recent utility bill (gas, electric, or phone depending on utility type claimed)",
      required: true,
    });
  }

  // Medical expenses for elderly/disabled
  const hasElderlyOrDisabled = (intake.householdMembers || []).some((m) => m.isElderly || m.isDisabled);
  if (hasElderlyOrDisabled) {
    docs.push({
      intakeId,
      documentType: "Medical expense receipts",
      description: "Receipts or statements for out-of-pocket medical expenses over $35/month (if claiming)",
      required: false,
    });
  }

  // Immigration documents — caseworker collects citizenship status directly;
  // always include as optional reminder
  docs.push({
    intakeId,
    documentType: "Immigration documents (if applicable)",
    description: "If not a U.S. citizen: permanent resident card, I-94, refugee/asylee documentation, or other proof of immigration status",
    required: false,
  });

  // Write all documents to DB (clear existing first to avoid duplicates on re-completion)
  await prisma.documentChecklist.deleteMany({ where: { intakeId } });
  for (const doc of docs) {
    await prisma.documentChecklist.create({ data: doc });
  }
}

/**
 * POST /api/intake/start
 * Start a new intake session. Returns session token, queue number, and welcome message.
 * Expects: { countyId, language, displayName } where displayName is "FirstName L." format.
 */
router.post("/start", requireStaffPin, intakeStartLimiter, async (req, res) => {
  try {
    const { countyId, language, displayName } = req.body;

    const nameErrors = validateDisplayName(displayName);
    if (nameErrors.length > 0) {
      return res.status(400).json({ error: nameErrors[0] });
    }

    const sessionToken = uuidv4();
    const queueNumber = generateQueueNumber();

    const intake = await withRetry(
      () => prisma.intake.create({
        data: {
          countyId: countyId || "dekalb-ga-001",
          sessionToken,
          queueNumber,
          status: "IN_PROGRESS",
        },
      }),
      { context: "intake.create", correlationId: req.correlationId }
    );

    // Create minimal applicant record (display name only — no PII)
    await withRetry(
      () => prisma.applicant.create({
        data: {
          intakeId: intake.id,
          displayName,
          languagePreference: language || "en",
        },
      }),
      { context: "applicant.create", correlationId: req.correlationId }
    );

    // Build system prompt and validate retrieval context (retrieval rail)
    const { prompt: systemPrompt, retrievalContext } = await buildSystemPromptWithContext("GA", 2026);
    const retrievalCheck = checkRetrievalRail(retrievalContext);
    if (!retrievalCheck.passed) {
      log.error("Retrieval rail failed — incomplete policy data", {
        correlationId: req.correlationId,
        missing: retrievalCheck.missing,
      });
      // Don't block the intake — the system prompt still works with
      // whatever data is available, but log for ops monitoring
    }

    const piiStripper = new PIIStripper();
    // Only mapping needed: the applicant's first name (for safety-net redaction)
    const firstName = displayName.split(" ")[0];
    if (firstName) piiStripper.addMapping(firstName, "[APPLICANT]");

    // Initialize dialog rail engine for conversation flow control
    const dialogRails = new DialogRailEngine();

    await sessionStore.set(sessionToken, {
      intakeId: intake.id,
      systemPrompt,
      conversationHistory: [],
      piiStripper,
      dialogRails: dialogRails.serialize(),
      turnNumber: 0,
      totalTokensUsed: 0,
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
      details: req.staffPinUsed ? { unlockedBy: req.staffPinUsed } : undefined,
    });

    // Send initial welcome message with applicant's first name
    const welcomeResponse = await sendMessage(
      [],
      systemPrompt,
      `I'm here to apply for SNAP benefits. My name is ${displayName}.`,
      sessionToken
    );

    const session = await sessionStore.get(sessionToken);
    session.conversationHistory.push(
      { role: "user", content: `I'm here to apply for SNAP benefits. My name is ${displayName}.` },
      { role: "assistant", content: welcomeResponse.rawMessage }
    );
    session.turnNumber = 1;
    await sessionStore.set(sessionToken, session);

    // Log the conversation turn
    await withRetry(
      () => prisma.conversationLog.createMany({
        data: [
          { intakeId: intake.id, turnNumber: 0, role: "SYSTEM", content: `Intake session started — ${displayName} (${queueNumber})` },
          { intakeId: intake.id, turnNumber: 1, role: "ASSISTANT", content: welcomeResponse.displayMessage },
        ],
      }),
      { context: "conversationLog.create", correlationId: req.correlationId }
    );

    log.info("Intake session started", {
      correlationId: req.correlationId,
      intakeId: intake.id,
      queueNumber,
    });

    res.json({
      sessionToken,
      intakeId: intake.id,
      queueNumber,
      message: welcomeResponse.displayMessage,
      section: "WELCOME",
    });
  } catch (error) {
    log.error("Failed to start intake session", {
      correlationId: req.correlationId,
      error: error.message,
    });
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

    // Validate session token format (UUID v4) to prevent enumeration/injection
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(sessionToken)) {
      return res.status(400).json({ error: "Invalid session token format" });
    }

    const session = await sessionStore.get(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found or expired" });
    }

    // Check session timeout
    if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
      await sessionStore.delete(sessionToken);
      return res.status(440).json({ error: "Session expired due to inactivity. Please start a new intake." });
    }

    // Prevent AI cost abuse: cap conversation turns per session
    if (session.turnNumber >= MAX_CONVERSATION_TURNS) {
      log.warn("Conversation turn limit reached", {
        correlationId: req.correlationId,
        intakeId: session.intakeId,
        turnNumber: session.turnNumber,
      });
      return res.status(429).json({
        error: "This session has reached the maximum number of messages. Please complete your intake or start a new session.",
      });
    }

    // Token budget enforcement: prevent cost abuse from long/complex conversations
    if ((session.totalTokensUsed || 0) >= MAX_SESSION_TOKENS) {
      log.warn("Session token budget exhausted", {
        correlationId: req.correlationId,
        intakeId: session.intakeId,
        totalTokensUsed: session.totalTokensUsed,
      });
      return res.status(429).json({
        error: "This session has used its allocated resources. Please complete your intake or start a new session.",
      });
    }

    await sessionStore.touch(sessionToken);

    // Session expiration warning (5 minutes before timeout)
    const timeRemaining = SESSION_TTL_MS - (Date.now() - session.lastActivity);
    const sessionExpiringWarning = timeRemaining < 5 * 60 * 1000
      ? { secondsRemaining: Math.round(timeRemaining / 1000), message: "Your session will expire soon due to inactivity. Please continue with your application." }
      : undefined;

    // Verify session matches intake
    const intake = await prisma.intake.findFirst({
      where: { id: session.intakeId, sessionToken },
    });
    if (!intake) {
      return res.status(401).json({ error: "Session mismatch" });
    }

    // ── Dialog Rails: restore engine state from session ────────────
    const dialogRails = DialogRailEngine.deserialize(session.dialogRails);

    // ── Dialog Rails: INPUT RAIL — check if message fits current flow
    const inputRailResult = dialogRails.checkInputRail(message);
    if (!inputRailResult.allowed && inputRailResult.redirectMessage) {
      // User is jumping ahead — prepend a gentle redirect to the message
      // but still process it (don't block the user, just guide them)
      log.info("Dialog rail: redirecting user", {
        correlationId: req.correlationId,
        currentSection: dialogRails.currentSection,
        attemptedSection: inputRailResult.attemptedSection,
      });
    }

    // Strip PII before sending to AI
    const strippedMessage = session.piiStripper.strip(message);

    // If dialog rail suggests redirecting, prepend context to help the AI stay on track
    let aiInputMessage = strippedMessage;
    if (!inputRailResult.allowed && inputRailResult.redirectMessage) {
      // Inject a subtle system-level hint so the AI stays in the current section
      aiInputMessage = strippedMessage;
      // Note: we don't modify the user message — the system prompt already
      // defines the section order. The redirect info is logged for monitoring.
    }

    // Send to AI
    const aiResponse = await sendMessage(
      session.piiStripper.stripConversation(session.conversationHistory),
      session.systemPrompt,
      aiInputMessage,
      sessionToken
    );

    // ── AI Output Guardrail Pipeline (OWASP LLM Top 10 2025 defense-in-depth) ──

    // Guard 1: Data block count limit
    const blockCheck = validateDataBlockCount(aiResponse.rawMessage);
    if (!blockCheck.safe) {
      log.warn("Excessive CUSHION_DATA blocks in AI response — possible injection", {
        correlationId: req.correlationId,
        intakeId: intake.id,
        dataBlockCount: blockCheck.count,
      });
      return res.json({
        message: "I had trouble processing that. Could you repeat your answer?",
        section: determineCurrentSection(session.conversationHistory),
        extractedData: [],
        model: aiResponse.model,
      });
    }

    // Guard 2: Exfiltration blocker — strip markdown images, external URLs, long query params
    const exfilCheck = blockExfiltration(aiResponse.displayMessage);
    if (!exfilCheck.safe) {
      log.warn("Exfiltration attempt blocked in AI response", {
        correlationId: req.correlationId,
        intakeId: intake.id,
        threats: exfilCheck.threats,
      });
      aiResponse.displayMessage = exfilCheck.cleaned;
    }

    // Guard 3: Output PII scanner — catch any PII the model generates
    const piiCheck = scanOutputForPII(aiResponse.displayMessage);
    if (!piiCheck.clean) {
      log.warn("PII detected in AI output — stripping before delivery", {
        correlationId: req.correlationId,
        intakeId: intake.id,
        piiTypes: piiCheck.piiFound,
      });
      // Re-run the PII stripper on the output to redact
      aiResponse.displayMessage = session.piiStripper.strip(aiResponse.displayMessage);
      await logAuditEvent({
        type: EVENTS.PII_STRIPPED,
        actorType: ACTORS.SYSTEM,
        actorId: "output-guardrail",
        intakeId: intake.id,
        details: { direction: "output", piiTypes: piiCheck.piiFound },
      });
    }

    // Guard 4: Section-aware context validation — the strongest signal.
    // Checks three axes: are the data fields appropriate for the current
    // section? Does the response vocabulary match the section? Does the
    // response contain forbidden content (eligibility claims, PII requests)?
    const currentSection = determineCurrentSection(session.conversationHistory);
    const contextCheck = validateConversationContext(
      currentSection,
      aiResponse.displayMessage,
      aiResponse.extractedData,
    );

    if (!contextCheck.ok) {
      // Log all failures for monitoring
      if (!contextCheck.fieldCheck.valid) {
        log.warn("Unexpected data fields for current section", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          section: currentSection,
          unexpectedFields: contextCheck.fieldCheck.unexpectedFields,
        });
      }
      if (!contextCheck.relevanceCheck.relevant) {
        log.warn("Off-topic AI response for current section", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          section: currentSection,
          score: contextCheck.relevanceCheck.score,
          reason: contextCheck.relevanceCheck.reason,
        });
      }
      if (!contextCheck.forbiddenCheck.clean) {
        log.error("Forbidden content detected in AI response", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          violations: contextCheck.forbiddenCheck.violations,
        });
        // Forbidden content is a hard block — return safe fallback
        return res.json({
          message: "I need to stay focused on your SNAP application. Could you repeat your last answer?",
          section: currentSection,
          extractedData: [],
          model: aiResponse.model,
        });
      }
      // Field mismatches and low relevance are soft warnings — log but don't block.
      // The AI sometimes legitimately transitions between sections mid-turn.
    }

    // Guard 5: Canary trip check (handled in aiAssistant.js — logged but double-check)
    if (aiResponse.canaryTripped) {
      log.error("Canary token leaked — system prompt exposed", {
        correlationId: req.correlationId,
        intakeId: intake.id,
      });
      await logAuditEvent({
        type: EVENTS.INJECTION_BLOCKED,
        actorType: ACTORS.SYSTEM,
        actorId: "canary-detector",
        intakeId: intake.id,
        details: { event: "CANARY_TOKEN_LEAKED", model: aiResponse.model },
      });
      return res.json({
        message: aiResponse.displayMessage,
        section: determineCurrentSection(session.conversationHistory),
        extractedData: [],
        model: aiResponse.model,
      });
    }

    // Update conversation history and track token usage
    session.conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: sanitizeAIResponse(aiResponse.rawMessage) }
    );
    session.turnNumber += 1;
    session.totalTokensUsed = (session.totalTokensUsed || 0) +
      (aiResponse.usage?.input_tokens || 0) +
      (aiResponse.usage?.output_tokens || 0);
    await sessionStore.set(sessionToken, session);

    // Validate extracted data with Zod schemas, then legacy validator, then persist
    const validatedData = [];
    for (const dataBlock of aiResponse.extractedData) {
      // Layer 1: Zod schema validation (strict type/range checking)
      const zodResult = validateAIResponse(dataBlock);
      if (!zodResult.valid) {
        log.warn("AI response Zod validation failed", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          field: dataBlock.field,
          errors: zodResult.errors,
        });
        continue;
      }

      // Use Zod-cleaned data (with transforms applied)
      const cleanedBlock = zodResult.data || dataBlock;

      // Layer 2: Legacy business-rule validation
      const legacyResult = validateExtractedData(cleanedBlock);
      if (!legacyResult.valid) {
        log.warn("AI response business validation failed", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          field: cleanedBlock.field,
          errors: legacyResult.errors,
        });
        continue;
      }

      validatedData.push(cleanedBlock);
      try {
        await withRetry(
          () => persistExtractedData(intake.id, cleanedBlock),
          { context: "persistExtractedData", correlationId: req.correlationId }
        );
      } catch (persistErr) {
        log.error("Data persistence failed", {
          correlationId: req.correlationId,
          intakeId: intake.id,
          field: cleanedBlock.field,
          error: persistErr.message,
        });
      }
    }

    // Log conversation turns (sanitize user input to prevent stored XSS in caseworker dashboard)
    await withRetry(
      () => prisma.conversationLog.createMany({
        data: [
          { intakeId: intake.id, turnNumber: session.turnNumber * 2 - 1, role: "USER", content: sanitizeForDisplay(message) },
          { intakeId: intake.id, turnNumber: session.turnNumber * 2, role: "ASSISTANT", content: aiResponse.displayMessage },
        ],
      }),
      { context: "conversationLog.create", correlationId: req.correlationId }
    );

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

    // ── Output guardrails ──────────────────────────────────────────
    // Check the AI's display message for policy violations before the
    // applicant sees it. This catches: eligibility determinations,
    // system prompt leakage, off-topic drift, PII echo, excess length.
    let finalDisplayMessage = aiResponse.displayMessage;
    const guardrailResult = runOutputGuardrails(finalDisplayMessage);

    if (guardrailResult.blocked) {
      // Severe violation — replace entire response with safe fallback
      log.error("Output guardrail BLOCKED response", {
        correlationId: req.correlationId,
        intakeId: intake.id,
        violations: guardrailResult.violations,
      });
      await logAuditEvent({
        type: EVENTS.AI_API_CALL,
        actorType: ACTORS.SYSTEM,
        actorId: "output-guardrail",
        intakeId: intake.id,
        details: {
          event: "RESPONSE_BLOCKED",
          violations: guardrailResult.violations,
        },
      });
      finalDisplayMessage = BLOCKED_RESPONSE;
    } else if (guardrailResult.correctedMessage) {
      // Auto-corrected (PII redacted, length trimmed)
      log.warn("Output guardrail corrected response", {
        correlationId: req.correlationId,
        intakeId: intake.id,
        violations: guardrailResult.violations,
      });
      finalDisplayMessage = guardrailResult.correctedMessage;
    }

    // Restore PII-mapped display names in the final message
    const displayMessage = session.piiStripper.restore(finalDisplayMessage);
    // Use dialog rail section (data-driven) with heuristic as fallback
    const section = dialogRails.currentSection || determineCurrentSection(session.conversationHistory);

    res.json({
      message: displayMessage,
      section,
      extractedData: validatedData,
      model: aiResponse.model,
      ...(sessionExpiringWarning && { sessionExpiringWarning }),
    });
  } catch (error) {
    log.error("Failed to process message", {
      correlationId: req.correlationId,
      error: error.message,
    });
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
    const sessionToken = req.headers["x-session-token"] || req.query.sessionToken;

    // Session token is required — prevents enumeration of intake IDs
    if (!sessionToken) {
      return res.status(401).json({ error: "Session token required" });
    }

    const intake = await withRetry(
      () => prisma.intake.findFirst({
        where: { id, sessionToken },
        include: {
          applicant: true,
          householdMembers: true,
          incomeSources: true,
          deductions: true,
          shelterExpense: true,
          documentChecklist: true,
          county: true,
        },
      }),
      { context: "intake.findFirst.summary", correlationId: req.correlationId }
    );

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
    log.error("Failed to generate summary", {
      correlationId: req.correlationId,
      intakeId: req.params.id,
      error: error.message,
    });
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

    if (!sessionToken) {
      return res.status(401).json({ error: "Session token required" });
    }

    const intake = await withRetry(
      () => prisma.intake.findFirst({
        where: { id, sessionToken, status: "IN_PROGRESS" },
        include: {
          applicant: true,
          householdMembers: true,
          incomeSources: true,
          shelterExpense: true,
        },
      }),
      { context: "intake.findFirst.complete", correlationId: req.correlationId }
    );

    if (!intake) {
      return res.status(404).json({ error: "Active intake not found" });
    }

    // Validate minimum data before allowing completion
    const completionErrors = [];
    if (!intake.applicant) {
      completionErrors.push("Applicant information is missing");
    }
    if ((intake.incomeSources || []).length === 0 && (intake.householdMembers || []).length === 0) {
      completionErrors.push("No income sources or household members recorded — at minimum, applicant income is required");
    }
    if (completionErrors.length > 0) {
      return res.status(400).json({
        error: "Intake cannot be completed — missing required information",
        details: completionErrors,
      });
    }

    // Run calculations
    const eligibility = await calculateFullEligibility(intake);
    const consistency = await runConsistencyChecks(intake, eligibility);

    // Update intake with results
    await withRetry(
      () => prisma.intake.update({
        where: { id },
        data: {
          status: "COMPLETED",
          riskScore: consistency.riskScore,
          expeditedFlag: eligibility.expedited.eligible,
          expeditedReason: eligibility.expedited.reasons?.join("; ") || null,
          consistencyFlags: consistency.flags,
        },
      }),
      { context: "intake.update.complete", correlationId: req.correlationId }
    );

    // Save deductions to DB
    for (const ded of eligibility.deductions.deductions) {
      await withRetry(
        () => prisma.deduction.create({
          data: {
            intakeId: id,
            deductionType: ded.type,
            amount: ded.amount,
            calculationNotes: ded.notes,
          },
        }),
        { context: "deduction.create", correlationId: req.correlationId }
      );
    }

    // Generate personalized document checklist based on collected data
    await generateDocumentChecklist(id);

    await logAuditEvent({
      type: EVENTS.INTAKE_COMPLETED,
      actorType: ACTORS.APPLICANT,
      actorId: sessionToken,
      intakeId: id,
      countyId: intake.countyId,
      ip: req.ip,
    });

    // Clean up session
    await sessionStore.delete(sessionToken);

    log.info("Intake completed", {
      correlationId: req.correlationId,
      intakeId: id,
      riskScore: consistency.riskScore,
      expedited: eligibility.expedited.eligible,
      flagCount: consistency.flags.length,
    });

    res.json({
      status: "COMPLETED",
      riskScore: consistency.riskScore,
      expedited: eligibility.expedited,
      flagCount: consistency.flags.length,
      estimatedBenefit: eligibility.benefitEstimate.estimatedBenefit,
    });
  } catch (error) {
    log.error("Failed to complete intake", {
      correlationId: req.correlationId,
      intakeId: req.params.id,
      error: error.message,
    });
    res.status(500).json({ error: "Failed to complete intake" });
  }
});

module.exports = router;
