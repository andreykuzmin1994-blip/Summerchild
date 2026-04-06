import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { runEvaluation, scoreContextPrecision, scoreFaithfulness, scoreAnswerRelevance } = require_("./ragasEvaluator");
const questions = require_("./snapPolicyQuestions.json");

/**
 * RAGAS Evaluation Benchmark — Vitest Integration
 *
 * Runs the RAGAS scoring pipeline and asserts minimum quality thresholds.
 * If the system prompt or policy questions change, these tests catch regressions
 * in the system's ability to answer SNAP policy questions accurately.
 */

describe("RAGAS Evaluation Benchmark", () => {
  const report = runEvaluation({ verbose: true });

  describe("Overall quality thresholds", () => {
    it("average context precision ≥ 70%", () => {
      expect(report.summary.averageScores.contextPrecision).toBeGreaterThanOrEqual(0.7);
    });

    it("average faithfulness ≥ 70%", () => {
      expect(report.summary.averageScores.faithfulness).toBeGreaterThanOrEqual(0.7);
    });

    it("average answer relevance ≥ 60%", () => {
      expect(report.summary.averageScores.answerRelevance).toBeGreaterThanOrEqual(0.6);
    });

    it("average overall score ≥ 65%", () => {
      expect(report.summary.averageScores.overall).toBeGreaterThanOrEqual(0.65);
    });
  });

  describe("All 20 policy questions are scoreable", () => {
    it("evaluates the correct number of questions", () => {
      expect(report.summary.totalQuestions).toBe(questions.length);
    });

    it("no question scores below 30% overall", () => {
      for (const result of report.details) {
        expect(result.scores.overall, `${result.id}: ${result.question}`).toBeGreaterThanOrEqual(0.3);
      }
    });
  });

  describe("Category coverage", () => {
    it("covers income_limits category", () => {
      expect(report.summary.byCategory.income_limits).toBeDefined();
    });

    it("covers deductions category", () => {
      expect(report.summary.byCategory.deductions).toBeDefined();
    });

    it("covers household category", () => {
      expect(report.summary.byCategory.household).toBeDefined();
    });

    it("covers expedited category", () => {
      expect(report.summary.byCategory.expedited).toBeDefined();
    });

    it("covers benefits category", () => {
      expect(report.summary.byCategory.benefits).toBeDefined();
    });
  });

  describe("Individual scoring functions", () => {
    const sampleItem = questions[0]; // gross_income_limit_hh3

    it("scoreContextPrecision returns 0-1", () => {
      const score = scoreContextPrecision(sampleItem);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("scoreFaithfulness returns 0-1", () => {
      const score = scoreFaithfulness(sampleItem);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("scoreAnswerRelevance returns 0-1", () => {
      const score = scoreAnswerRelevance(sampleItem);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe("Category filtering", () => {
    it("can filter by category", () => {
      const deductionsOnly = runEvaluation({ category: "deductions" });
      expect(deductionsOnly.summary.totalQuestions).toBeLessThan(questions.length);
      expect(deductionsOnly.summary.totalQuestions).toBeGreaterThan(0);
    });
  });
});
