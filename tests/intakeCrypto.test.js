import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the read-path walker that decrypts v2 PII fields on an
 * intake tree returned by Prisma.
 */

const { encrypt } = require("../src/lib/fieldCrypto");
const { decryptIntakeTreeInPlace, SENTINEL_DECRYPT_FAILED } = require("../src/lib/intakeCrypto");

const COUNTY = "county-A";
const INTAKE_ID = "11111111-1111-4111-8111-111111111111";
const APPLICANT_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID_1 = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID_2 = "44444444-4444-4444-8444-444444444444";

const MEMBER_ID_1 = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID_2 = "66666666-6666-4666-8666-666666666666";

function encryptMemberName(name, memberId) {
  return encrypt(name, {
    table: "household_members",
    column: "display_name",
    countyId: COUNTY,
    rowId: memberId,
  });
}

function buildIntake({
  encryptedDisplay = true,
  reviewNotes = [],
  householdMembers = [],
  incomeSourcesWithMember = [],
} = {}) {
  return {
    id: INTAKE_ID,
    countyId: COUNTY,
    applicant: {
      id: APPLICANT_ID,
      displayName: encryptedDisplay
        ? encrypt("Maria G.", {
            table: "applicants",
            column: "display_name",
            countyId: COUNTY,
            rowId: APPLICANT_ID,
          })
        : "Maria G.", // legacy plaintext row
    },
    householdMembers: householdMembers.map((name, i) => {
      const memberId = [MEMBER_ID_1, MEMBER_ID_2][i];
      return { id: memberId, displayName: encryptMemberName(name, memberId) };
    }),
    incomeSources: incomeSourcesWithMember.map((name, i) => {
      const memberId = [MEMBER_ID_1, MEMBER_ID_2][i];
      return {
        householdMember: { id: memberId, displayName: encryptMemberName(name, memberId) },
      };
    }),
    reviews: reviewNotes.map((notes, i) => {
      const rowId = [REVIEW_ID_1, REVIEW_ID_2][i];
      return {
        id: rowId,
        notes: notes === null
          ? null
          : encrypt(notes, {
              table: "intake_reviews",
              column: "notes",
              countyId: COUNTY,
              rowId,
            }),
      };
    }),
  };
}

describe("decryptIntakeTreeInPlace", () => {
  it("decrypts Applicant.displayName in place", () => {
    const intake = buildIntake();
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.applicant.displayName).toBe("Maria G.");
  });

  it("decrypts every IntakeReview.notes in place", () => {
    const intake = buildIntake({
      reviewNotes: ["first review note", "second note with more detail"],
    });
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.reviews[0].notes).toBe("first review note");
    expect(intake.reviews[1].notes).toBe("second note with more detail");
  });

  it("decrypts HouseholdMember.displayName on the top-level include", () => {
    const intake = buildIntake({
      householdMembers: ["James R.", "Sofia T."],
    });
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.householdMembers[0].displayName).toBe("James R.");
    expect(intake.householdMembers[1].displayName).toBe("Sofia T.");
  });

  it("decrypts the nested IncomeSource.householdMember.displayName", () => {
    const intake = buildIntake({
      incomeSourcesWithMember: ["James R.", "Sofia T."],
    });
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.incomeSources[0].householdMember.displayName).toBe("James R.");
    expect(intake.incomeSources[1].householdMember.displayName).toBe("Sofia T.");
  });

  it("AAD cross-row binding: swapping ciphertext between members produces sentinels", () => {
    const a = encryptMemberName("James R.", MEMBER_ID_1);
    const b = encryptMemberName("Sofia T.", MEMBER_ID_2);
    const intake = {
      id: INTAKE_ID,
      countyId: COUNTY,
      householdMembers: [
        { id: MEMBER_ID_1, displayName: b }, // swapped — should fail auth tag
        { id: MEMBER_ID_2, displayName: a },
      ],
    };
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.householdMembers[0].displayName).toBe(SENTINEL_DECRYPT_FAILED);
    expect(intake.householdMembers[1].displayName).toBe(SENTINEL_DECRYPT_FAILED);
  });

  it("passes through legacy plaintext rows unchanged", () => {
    const intake = buildIntake({ encryptedDisplay: false });
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.applicant.displayName).toBe("Maria G.");
  });

  it("passes through null review notes without touching them", () => {
    const intake = buildIntake({ reviewNotes: [null] });
    decryptIntakeTreeInPlace(intake, COUNTY);
    expect(intake.reviews[0].notes).toBeNull();
  });

  it("wrong county in the decrypt context surfaces the sentinel", () => {
    const intake = buildIntake();
    decryptIntakeTreeInPlace(intake, "county-B");
    expect(intake.applicant.displayName).toBe(SENTINEL_DECRYPT_FAILED);
  });

  it("no-ops on null intake", () => {
    expect(decryptIntakeTreeInPlace(null, COUNTY)).toBeNull();
  });

  it("no-ops when countyId cannot be determined", () => {
    const intake = { id: INTAKE_ID, countyId: null, applicant: { id: APPLICANT_ID, displayName: "x" } };
    decryptIntakeTreeInPlace(intake);
    // Walker returns without touching fields — plaintext stays plaintext,
    // ciphertext would stay ciphertext (not tested here).
    expect(intake.applicant.displayName).toBe("x");
  });

  it("falls back to intake.countyId when viewer countyId is not passed", () => {
    const intake = buildIntake();
    decryptIntakeTreeInPlace(intake); // no viewer county — uses intake.countyId
    expect(intake.applicant.displayName).toBe("Maria G.");
  });
});
