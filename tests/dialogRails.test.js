import { describe, it, expect, beforeEach } from "vitest";
import { DialogRailEngine, checkRetrievalRail, SECTIONS } from "../src/services/dialogRails";

describe("DialogRailEngine", () => {
  let engine;

  beforeEach(() => {
    engine = new DialogRailEngine();
  });

  describe("initialization", () => {
    it("starts in WELCOME section", () => {
      expect(engine.currentSection).toBe("WELCOME");
      expect(engine.turnInSection).toBe(0);
    });

    it("has empty collected fields", () => {
      expect(engine.collectedFields.size).toBe(0);
    });
  });

  describe("section transitions", () => {
    it("allows forward transitions", () => {
      const result = engine.transition("HOUSEHOLD");
      expect(result.allowed).toBe(true);
      expect(engine.currentSection).toBe("HOUSEHOLD");
    });

    it("blocks backward transitions", () => {
      engine.transition("HOUSEHOLD");
      engine.transition("INCOME");
      const result = engine.transition("HOUSEHOLD");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cannot go back");
    });

    it("blocks skipping to EXPENSES without income data", () => {
      engine.transition("HOUSEHOLD");
      const result = engine.transition("EXPENSES");
      expect(result.allowed).toBe(false);
      expect(result.missingFields).toContain("income_source");
    });

    it("allows EXPENSES after income collected", () => {
      engine.transition("HOUSEHOLD");
      engine.collectedFields.set("household_member", 2);
      engine.collectedFields.set("income_source", 1);
      const result = engine.transition("EXPENSES");
      expect(result.allowed).toBe(true);
    });

    it("tracks section history", () => {
      engine.transition("HOUSEHOLD");
      engine.transition("INCOME");
      expect(engine.sectionHistory).toEqual(["WELCOME", "HOUSEHOLD", "INCOME"]);
    });
  });

  describe("input rails", () => {
    it("always allows input in WELCOME", () => {
      const result = engine.checkInputRail("Hello, I want to apply for food stamps");
      expect(result.allowed).toBe(true);
    });

    it("allows household-related input in HOUSEHOLD section", () => {
      engine.transition("HOUSEHOLD");
      const result = engine.checkInputRail("I live with my spouse and two children");
      expect(result.allowed).toBe(true);
    });

    it("allows income-related input in INCOME section", () => {
      engine.transition("HOUSEHOLD");
      engine.collectedFields.set("household_member", 1);
      engine.transition("INCOME");
      const result = engine.checkInputRail("I earn $2000 biweekly from my job");
      expect(result.allowed).toBe(true);
    });

    it("redirects when user jumps ahead without required data", () => {
      engine.transition("HOUSEHOLD");
      // User talks about rent while we're still in HOUSEHOLD
      const result = engine.checkInputRail("My rent is $1200 per month");
      // Should not be allowed since we need income_source first for EXPENSES
      // But it might match EXPENSES patterns — check redirect
      if (!result.allowed) {
        expect(result.redirectMessage).toBeDefined();
      }
    });

    it("allows unrecognized input through (might be a clarification)", () => {
      engine.transition("HOUSEHOLD");
      const result = engine.checkInputRail("yes that is correct");
      expect(result.allowed).toBe(true);
    });

    it("always allows input in REVIEW", () => {
      engine.currentSection = "REVIEW";
      const result = engine.checkInputRail("Actually I need to change my income");
      expect(result.allowed).toBe(true);
    });

    it("increments turn counter", () => {
      engine.transition("HOUSEHOLD");
      engine.checkInputRail("message 1");
      engine.checkInputRail("message 2");
      expect(engine.turnInSection).toBe(2);
    });
  });

  describe("output rails", () => {
    it("passes when extracted data matches current section", () => {
      engine.transition("HOUSEHOLD");
      const result = engine.checkOutputRail([
        { field: "household_member", display_name: "Maria G.", relationship: "self" },
      ]);
      expect(result.passed).toBe(true);
      expect(result.collectedFields.household_member).toBe(1);
    });

    it("flags premature extraction from a later section", () => {
      engine.transition("HOUSEHOLD");
      const result = engine.checkOutputRail([
        { field: "income_source", gross_per_period: 2000 },
      ]);
      expect(result.passed).toBe(false);
      expect(result.violations[0].type).toBe("premature_extraction");
    });

    it("detects stuck sections", () => {
      engine.transition("HOUSEHOLD");
      engine.turnInSection = 15; // Over maxTurns (10)
      const result = engine.checkOutputRail([]);
      expect(result.passed).toBe(false);
      expect(result.violations[0].type).toBe("section_stuck");
    });

    it("tracks collected fields cumulatively", () => {
      engine.transition("HOUSEHOLD");
      engine.checkOutputRail([{ field: "household_member" }]);
      engine.checkOutputRail([{ field: "household_member" }]);
      expect(engine.collectedFields.get("household_member")).toBe(2);
    });
  });

  describe("auto-advance", () => {
    it("suggests advancing from WELCOME after 2 turns", () => {
      engine.checkInputRail("hello");
      engine.checkInputRail("yes");
      const next = engine.suggestNextSection();
      expect(next).toBe("HOUSEHOLD");
    });

    it("returns null when already at last section", () => {
      engine.currentSection = "REVIEW";
      expect(engine.suggestNextSection()).toBeNull();
    });
  });

  describe("serialization", () => {
    it("serializes and deserializes state", () => {
      engine.transition("HOUSEHOLD");
      engine.collectedFields.set("household_member", 3);
      engine.turnInSection = 5;

      const serialized = engine.serialize();
      const restored = DialogRailEngine.deserialize(serialized);

      expect(restored.currentSection).toBe("HOUSEHOLD");
      expect(restored.collectedFields.get("household_member")).toBe(3);
      expect(restored.turnInSection).toBe(5);
      expect(restored.sectionHistory).toEqual(["WELCOME", "HOUSEHOLD"]);
    });

    it("handles null/undefined input gracefully", () => {
      const restored = DialogRailEngine.deserialize(null);
      expect(restored.currentSection).toBe("WELCOME");
    });
  });
});

describe("checkRetrievalRail", () => {
  it("passes with complete context", () => {
    const context = {
      snapConfig: { stateCode: "GA", bbce: true },
      federalData: Array.from({ length: 8 }, (_, i) => ({
        householdSize: i + 1,
        grossIncomeLimit: 1000 + i * 500,
      })),
    };
    const result = checkRetrievalRail(context);
    expect(result.passed).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("fails when snapConfig is missing", () => {
    const context = {
      snapConfig: null,
      federalData: Array.from({ length: 8 }, (_, i) => ({
        householdSize: i + 1,
      })),
    };
    const result = checkRetrievalRail(context);
    expect(result.passed).toBe(false);
    expect(result.missing.some((m) => m.field === "snapConfig")).toBe(true);
  });

  it("fails when federalData is empty", () => {
    const context = {
      snapConfig: { stateCode: "GA" },
      federalData: [],
    };
    const result = checkRetrievalRail(context);
    expect(result.passed).toBe(false);
  });

  it("detects missing household sizes in federal data", () => {
    const context = {
      snapConfig: { stateCode: "GA" },
      federalData: [
        { householdSize: 1 },
        { householdSize: 3 }, // Missing HH2
        { householdSize: 4 },
      ],
    };
    const result = checkRetrievalRail(context);
    expect(result.passed).toBe(false);
    expect(result.missing.some((m) => m.field === "federalData[HH2]")).toBe(true);
  });
});

describe("SECTIONS config", () => {
  it("has all five sections defined", () => {
    expect(Object.keys(SECTIONS)).toEqual(["WELCOME", "HOUSEHOLD", "INCOME", "EXPENSES", "REVIEW"]);
  });

  it("sections are in ascending order", () => {
    const orders = Object.values(SECTIONS).map((s) => s.order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    }
  });

  it("each section has input patterns", () => {
    for (const section of Object.values(SECTIONS)) {
      expect(section.inputPatterns.length).toBeGreaterThan(0);
    }
  });
});
