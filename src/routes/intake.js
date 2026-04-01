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

const { getStandardUtilityAllowance, calculateMonthlyIncome, FREQUENCY_MULTIPLIERS } = require("../services/snapCalculator");
const gatewayFields = require("../config/gateway-snap-fields.json");

const prisma = new PrismaClient();
const router = express.Router();

// Queue number counter (resets daily in production; in-memory for demo)
let queueCounter = 0;
function generateQueueNumber() {
  queueCounter += 1;
  const letter = String.fromCharCode(65 + Math.floor((queueCounter - 1) / 100)); // A, B, C...
  const num = String(((queueCounter - 1) % 100) + 1).padStart(4, "0");
  return `${letter}-${num}`;
}

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
router.post("/start", async (req, res) => {
  try {
    const { countyId, language, displayName } = req.body;

    if (!displayName || displayName.length < 2) {
      return res.status(400).json({ error: "Please provide your first name and last initial (e.g., 'Maria G.')" });
    }

    const sessionToken = uuidv4();
    const queueNumber = generateQueueNumber();

    const intake = await prisma.intake.create({
      data: {
        countyId: countyId || "dekalb-ga-001",
        sessionToken,
        queueNumber,
        status: "IN_PROGRESS",
      },
    });

    // Create minimal applicant record (display name only — no PII)
    await prisma.applicant.create({
      data: {
        intakeId: intake.id,
        displayName,
        languagePreference: language || "en",
      },
    });

    // Build system prompt and cache it for this session
    const systemPrompt = await buildSystemPrompt("GA", 2026);

    const piiStripper = new PIIStripper();
    // Only mapping needed: the applicant's first name (for safety-net redaction)
    const firstName = displayName.split(" ")[0];
    if (firstName) piiStripper.addMapping(firstName, "[APPLICANT]");

    sessions.set(sessionToken, {
      intakeId: intake.id,
      systemPrompt,
      conversationHistory: [],
      piiStripper,
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

    // Send initial welcome message with applicant's first name
    const welcomeResponse = await sendMessage(
      [],
      systemPrompt,
      `I'm here to apply for SNAP benefits. My name is ${displayName}.`,
      sessionToken
    );

    sessions.get(sessionToken).conversationHistory.push(
      { role: "user", content: `I'm here to apply for SNAP benefits. My name is ${displayName}.` },
      { role: "assistant", content: welcomeResponse.rawMessage }
    );
    sessions.get(sessionToken).turnNumber = 1;

    // Log the conversation turn
    await prisma.conversationLog.createMany({
      data: [
        { intakeId: intake.id, turnNumber: 0, role: "SYSTEM", content: `Intake session started — ${displayName} (${queueNumber})` },
        { intakeId: intake.id, turnNumber: 1, role: "ASSISTANT", content: welcomeResponse.displayMessage },
      ],
    });

    res.json({
      sessionToken,
      intakeId: intake.id,
      queueNumber,
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
      strippedMessage,
      sessionToken
    );

    // Update conversation history
    session.conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: aiResponse.rawMessage }
    );
    session.turnNumber += 1;

    // Validate and persist extracted data
    const validatedData = [];
    for (const dataBlock of aiResponse.extractedData) {
      const validation = validateExtractedData(dataBlock);
      if (validation.valid) {
        validatedData.push(dataBlock);
        try {
          await persistExtractedData(intake.id, dataBlock);
        } catch (persistErr) {
          console.error("[DATA PERSIST]", persistErr.message, dataBlock);
        }
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
