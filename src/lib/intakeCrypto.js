/**
 * Read-path helper that decrypts v2-encrypted fields on a Prisma intake
 * tree in place. Centralizes the (table, column, rowId) mapping so each
 * route handler does not have to spell out the AAD context.
 *
 * v1-encrypted fields (ConversationLog.content) are NOT handled here —
 * they have a different AAD (intakeId) and are decrypted by the caller
 * via safeDecryptV1.
 *
 * Currently covers:
 *   - Applicant.displayName                        → rowId = applicant.id
 *   - HouseholdMember.displayName                  → rowId = member.id
 *   - IncomeSource.householdMember.displayName     → rowId = nested member.id
 *   - IncomeSource.employerOrPayerName             → rowId = income_source.id
 *   - Deduction.calculationNotes                   → rowId = deduction.id
 *   - IntakeReview.notes                           → rowId = review.id
 */

const { safeDecrypt, SENTINEL_DECRYPT_FAILED } = require("./fieldCrypto");
const { logAuditEvent, EVENTS, ACTORS } = require("../services/auditLogger");
const { child } = require("../services/logger");

const log = child("intake-crypto");

/**
 * Decrypt-in-place walker. Mutates `intake` to replace ciphertext fields
 * with their plaintext form. Designed for the shape returned by
 * `prisma.intake.findFirst({ include: { applicant: true, reviews: {...} } })`.
 *
 * Any decrypt failure surfaces as the SENTINEL_DECRYPT_FAILED constant on
 * that single field and emits an audit event. Never throws.
 *
 * @param {object} intake — Prisma intake row with relations included
 * @param {string} countyId — viewer's county; used for the AAD, MUST match
 *   the county the row was encrypted under (normally intake.countyId)
 */
function decryptIntakeTreeInPlace(intake, countyId) {
  if (!intake) return intake;
  const aadCountyId = countyId || intake.countyId;
  if (!aadCountyId) return intake; // cannot decrypt without a countyId

  // Applicant.displayName
  if (intake.applicant && intake.applicant.displayName !== null) {
    intake.applicant.displayName = safeFieldDecrypt({
      ciphertext: intake.applicant.displayName,
      table: "applicants",
      column: "display_name",
      countyId: aadCountyId,
      rowId: intake.applicant.id,
      intakeId: intake.id,
    });
  }

  // HouseholdMember.displayName (array, top-level include)
  if (Array.isArray(intake.householdMembers)) {
    for (const m of intake.householdMembers) {
      if (m.displayName !== null && m.displayName !== undefined) {
        m.displayName = safeFieldDecrypt({
          ciphertext: m.displayName,
          table: "household_members",
          column: "display_name",
          countyId: aadCountyId,
          rowId: m.id,
          intakeId: intake.id,
        });
      }
    }
  }

  // IncomeSource: both a direct field (employerOrPayerName on the source
  // row itself) and a nested include (householdMember.displayName). Each
  // has its own rowId — the source's id for the first, the member's id
  // for the second.
  if (Array.isArray(intake.incomeSources)) {
    for (const src of intake.incomeSources) {
      if (src.employerOrPayerName !== null && src.employerOrPayerName !== undefined) {
        src.employerOrPayerName = safeFieldDecrypt({
          ciphertext: src.employerOrPayerName,
          table: "income_sources",
          column: "employer_or_payer_name",
          countyId: aadCountyId,
          rowId: src.id,
          intakeId: intake.id,
        });
      }
      if (src.householdMember && src.householdMember.displayName !== null
          && src.householdMember.displayName !== undefined) {
        src.householdMember.displayName = safeFieldDecrypt({
          ciphertext: src.householdMember.displayName,
          table: "household_members",
          column: "display_name",
          countyId: aadCountyId,
          rowId: src.householdMember.id,
          intakeId: intake.id,
        });
      }
    }
  }

  // Deduction.calculationNotes (array)
  if (Array.isArray(intake.deductions)) {
    for (const d of intake.deductions) {
      if (d.calculationNotes !== null && d.calculationNotes !== undefined) {
        d.calculationNotes = safeFieldDecrypt({
          ciphertext: d.calculationNotes,
          table: "deductions",
          column: "calculation_notes",
          countyId: aadCountyId,
          rowId: d.id,
          intakeId: intake.id,
        });
      }
    }
  }

  // IntakeReview.notes (array)
  if (Array.isArray(intake.reviews)) {
    for (const review of intake.reviews) {
      if (review.notes !== null) {
        review.notes = safeFieldDecrypt({
          ciphertext: review.notes,
          table: "intake_reviews",
          column: "notes",
          countyId: aadCountyId,
          rowId: review.id,
          intakeId: intake.id,
        });
      }
    }
  }

  return intake;
}

function safeFieldDecrypt({ ciphertext, table, column, countyId, rowId, intakeId }) {
  return safeDecrypt(ciphertext, { table, column, countyId, rowId }, (info) => {
    // Fire-and-forget audit — logAuditEvent swallows its own errors.
    logAuditEvent({
      type: EVENTS.FIELD_DECRYPT_FAILED,
      actorType: ACTORS.SYSTEM,
      actorId: "field-crypto",
      intakeId,
      countyId,
      details: {
        table,
        column,
        rowId,
        errorName: info.name,
      },
    }).catch(() => { /* never rethrow */ });
    log.warn("v2 field decrypt failed", {
      table, column, rowId, intakeId, errorName: info.name,
    });
  });
}

module.exports = {
  decryptIntakeTreeInPlace,
  SENTINEL_DECRYPT_FAILED,
};
