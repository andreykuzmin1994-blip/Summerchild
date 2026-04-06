/**
 * RAGAS-Inspired Evaluation Benchmark for Cushion Gov System Prompt
 *
 * Measures how well the AI system prompt enables accurate SNAP policy answers.
 * Adapted from the RAGAS framework (Retrieval Augmented Generation Assessment)
 * for our structured-context (non-RAG) architecture.
 *
 * Metrics:
 * 1. Context Precision — Does the system prompt contain the information needed
 *    to answer each question? (deterministic, no LLM needed)
 * 2. Faithfulness — Does the expected answer align with the system prompt context?
 *    (deterministic check against provided context strings)
 * 3. Answer Relevance — Does the expected answer actually address the question?
 *    (keyword overlap heuristic)
 *
 * Usage:
 *   node tests/ragas/ragasEvaluator.js
 *   node tests/ragas/ragasEvaluator.js --verbose
 *   node tests/ragas/ragasEvaluator.js --category deductions
 */

const path = require("path");
const questions = require("./snapPolicyQuestions.json");

// ── Metric 1: Context Precision ──────────────────────────────────────────
// Checks if the context snippet contains key terms from the expected answer.
// Higher score = the system prompt has the right info to answer the question.

function scoreContextPrecision(item) {
  const context = item.context.toLowerCase();
  const answer = item.expectedAnswer.toLowerCase();

  // Extract dollar amounts and key numbers from the expected answer
  const dollarAmounts = answer.match(/\$[\d,]+/g) || [];
  const percentages = answer.match(/\d+%/g) || [];
  const keyNumbers = [...dollarAmounts, ...percentages];

  // Check how many key numbers appear in the context
  let found = 0;
  for (const num of keyNumbers) {
    if (context.includes(num.replace(",", ""))) found++;
  }

  const numberScore = keyNumbers.length > 0 ? found / keyNumbers.length : 1;

  // Check if the CFR citation is in the context
  const citationPresent = context.includes("§") || context.includes("cfr") ? 1 : 0.5;

  return Math.min(1, (numberScore + citationPresent) / 2);
}

// ── Metric 2: Faithfulness ───────────────────────────────────────────────
// Checks that every claim in the expected answer can be traced to the context.
// Measures whether the answer is grounded in the provided regulatory data.

function scoreFaithfulness(item) {
  const context = item.context.toLowerCase();
  const answer = item.expectedAnswer.toLowerCase();

  // Split the answer into sentence-level claims
  const claims = answer.split(/[.!]/).filter(s => s.trim().length > 10);

  if (claims.length === 0) return 1;

  let supported = 0;
  for (const claim of claims) {
    // Extract significant words (>4 chars) from the claim
    const words = claim.match(/\b\w{5,}\b/g) || [];
    const matchCount = words.filter(w => context.includes(w)).length;

    // A claim is "supported" if ≥40% of its significant words appear in context
    if (words.length === 0 || matchCount / words.length >= 0.4) {
      supported++;
    }
  }

  return supported / claims.length;
}

// ── Metric 3: Answer Relevance ───────────────────────────────────────────
// Checks whether the expected answer addresses the question asked.
// Uses keyword overlap between question and answer.

function scoreAnswerRelevance(item) {
  const question = item.question.toLowerCase();
  const answer = item.expectedAnswer.toLowerCase();

  // Extract question keywords (nouns/verbs, >3 chars, skip stop words)
  const stopWords = new Set(["what", "does", "how", "the", "for", "that", "this",
    "with", "from", "are", "can", "will", "has", "who", "which", "where", "when",
    "there", "their", "they", "been", "have", "being", "your", "about", "would",
    "could", "should", "much", "many", "into", "also", "than", "only", "very",
    "just", "some"]);

  const questionWords = question.match(/\b\w{4,}\b/g) || [];
  const significantWords = questionWords.filter(w => !stopWords.has(w));

  if (significantWords.length === 0) return 1;

  const matched = significantWords.filter(w => answer.includes(w)).length;
  return matched / significantWords.length;
}

// ── Overall Scoring ──────────────────────────────────────────────────────

function evaluateQuestion(item) {
  const contextPrecision = scoreContextPrecision(item);
  const faithfulness = scoreFaithfulness(item);
  const answerRelevance = scoreAnswerRelevance(item);

  // Weighted average (faithfulness most important for gov use)
  const overall = (contextPrecision * 0.3) + (faithfulness * 0.4) + (answerRelevance * 0.3);

  return {
    id: item.id,
    question: item.question,
    category: item.category,
    difficulty: item.difficulty,
    cfrCitation: item.cfrCitation,
    scores: {
      contextPrecision: Math.round(contextPrecision * 100) / 100,
      faithfulness: Math.round(faithfulness * 100) / 100,
      answerRelevance: Math.round(answerRelevance * 100) / 100,
      overall: Math.round(overall * 100) / 100,
    },
  };
}

function runEvaluation(options = {}) {
  const { category, verbose } = options;

  let items = questions;
  if (category) {
    items = questions.filter(q => q.category === category);
  }

  const results = items.map(evaluateQuestion);

  // Aggregate scores
  const avgScores = {
    contextPrecision: 0,
    faithfulness: 0,
    answerRelevance: 0,
    overall: 0,
  };

  for (const r of results) {
    avgScores.contextPrecision += r.scores.contextPrecision;
    avgScores.faithfulness += r.scores.faithfulness;
    avgScores.answerRelevance += r.scores.answerRelevance;
    avgScores.overall += r.scores.overall;
  }

  const count = results.length;
  for (const key of Object.keys(avgScores)) {
    avgScores[key] = Math.round((avgScores[key] / count) * 100) / 100;
  }

  // Category breakdown
  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) {
      categories[r.category] = { count: 0, totalOverall: 0 };
    }
    categories[r.category].count++;
    categories[r.category].totalOverall += r.scores.overall;
  }
  for (const cat of Object.keys(categories)) {
    categories[cat].avgOverall = Math.round((categories[cat].totalOverall / categories[cat].count) * 100) / 100;
    delete categories[cat].totalOverall;
  }

  // Difficulty breakdown
  const difficulties = {};
  for (const r of results) {
    if (!difficulties[r.difficulty]) {
      difficulties[r.difficulty] = { count: 0, totalOverall: 0 };
    }
    difficulties[r.difficulty].count++;
    difficulties[r.difficulty].totalOverall += r.scores.overall;
  }
  for (const diff of Object.keys(difficulties)) {
    difficulties[diff].avgOverall = Math.round((difficulties[diff].totalOverall / difficulties[diff].count) * 100) / 100;
    delete difficulties[diff].totalOverall;
  }

  // Find weakest questions (lowest overall score)
  const weakest = [...results].sort((a, b) => a.scores.overall - b.scores.overall).slice(0, 5);

  return {
    summary: {
      totalQuestions: count,
      averageScores: avgScores,
      byCategory: categories,
      byDifficulty: difficulties,
    },
    weakestQuestions: weakest.map(r => ({
      id: r.id,
      question: r.question,
      overall: r.scores.overall,
    })),
    details: verbose ? results : undefined,
  };
}

// ── CLI Runner ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const catIdx = args.indexOf("--category");
  const category = catIdx >= 0 ? args[catIdx + 1] : undefined;

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  RAGAS Evaluation Benchmark — Cushion Gov SNAP Policy    ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  const report = runEvaluation({ category, verbose });

  console.log(`Questions evaluated: ${report.summary.totalQuestions}`);
  if (category) console.log(`Filtered by category: ${category}`);
  console.log("");

  console.log("AVERAGE SCORES:");
  console.log(`  Context Precision : ${(report.summary.averageScores.contextPrecision * 100).toFixed(0)}%`);
  console.log(`  Faithfulness      : ${(report.summary.averageScores.faithfulness * 100).toFixed(0)}%`);
  console.log(`  Answer Relevance  : ${(report.summary.averageScores.answerRelevance * 100).toFixed(0)}%`);
  console.log(`  Overall           : ${(report.summary.averageScores.overall * 100).toFixed(0)}%`);
  console.log("");

  console.log("BY CATEGORY:");
  for (const [cat, data] of Object.entries(report.summary.byCategory)) {
    console.log(`  ${cat.padEnd(20)} ${(data.avgOverall * 100).toFixed(0)}% (${data.count} questions)`);
  }
  console.log("");

  console.log("BY DIFFICULTY:");
  for (const [diff, data] of Object.entries(report.summary.byDifficulty)) {
    console.log(`  ${diff.padEnd(20)} ${(data.avgOverall * 100).toFixed(0)}% (${data.count} questions)`);
  }
  console.log("");

  if (report.weakestQuestions.length > 0) {
    console.log("WEAKEST QUESTIONS (areas to improve):");
    for (const q of report.weakestQuestions) {
      console.log(`  ${(q.overall * 100).toFixed(0)}% — ${q.question}`);
    }
  }

  if (verbose && report.details) {
    console.log("\nDETAILED RESULTS:");
    for (const r of report.details) {
      console.log(`\n  [${r.id}] ${r.question}`);
      console.log(`    Context Precision: ${(r.scores.contextPrecision * 100).toFixed(0)}%`);
      console.log(`    Faithfulness:      ${(r.scores.faithfulness * 100).toFixed(0)}%`);
      console.log(`    Answer Relevance:  ${(r.scores.answerRelevance * 100).toFixed(0)}%`);
      console.log(`    Overall:           ${(r.scores.overall * 100).toFixed(0)}%`);
      console.log(`    CFR: ${r.cfrCitation}`);
    }
  }
}

module.exports = { runEvaluation, scoreContextPrecision, scoreFaithfulness, scoreAnswerRelevance };
