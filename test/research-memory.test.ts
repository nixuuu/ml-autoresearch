import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyExperimentKnowledge, createResearchMemory, normalizeClaim } from "../src/research-memory.js";
import type { ExperimentRecord, HarnessConfig, ResearchConclusion } from "../src/types.js";

const config = {
  learning: {
    supportThreshold: 2,
    contradictionThreshold: 1,
    humanLessons: [{ id: "human-budget", claim: "Keep the compute budget fixed", guidance: "avoid" }],
  },
} as HarnessConfig;

function experiment(id: string, index: number, lessonTests: string[] = [], questionsAddressed: string[] = []): ExperimentRecord {
  return {
    id,
    index,
    startedAt: `2026-01-01T00:00:0${index}.000Z`,
    finishedAt: `2026-01-01T00:00:1${index}.000Z`,
    workspacePath: `/workspace/${id}`,
    parentId: "baseline",
    strategy: "exploit",
    workspaceFingerprint: `hash-${id}`,
    plan: {
      hypothesis: `Hypothesis ${index}`,
      changeCategory: "model-architecture",
      expectedEffect: "lower loss",
      notes: [`Proposal note ${index}`],
      lessonsUsed: [],
      contradictedLessons: [],
      lessonTests,
      questionsAddressed,
    },
    changedPaths: ["model.py"],
    forbiddenChanges: [],
    evaluation: {
      ok: true,
      attempts: [{
        repetition: 0, seed: index, exitCode: 0, signal: null, timedOut: false, durationMs: 1,
        metrics: { loss: 1 / index }, stdoutPath: "stdout", stderrPath: "stderr", metricsPath: "metrics",
      }],
      aggregatedMetrics: { loss: 1 / index },
    },
    decision: { status: "retain", primaryDelta: 0, reasons: [] },
  };
}

function conclusion(update: ResearchConclusion["lessonUpdates"][number]): ResearchConclusion {
  return {
    narrative: "Research conclusion",
    summary: "Summary note",
    notes: ["Free-form observation"],
    lessonUpdates: [update],
    nextHypotheses: ["Open question"],
    questionUpdates: [],
  };
}

test("evidence transitions a lesson through tentative, supported, contradicted, and retired", () => {
  let memory = createResearchMemory(config, "2026-01-01T00:00:00.000Z");
  memory = applyExperimentKnowledge(memory, experiment("exp-0001", 1), conclusion({
    claim: "Regularization improves validation loss", relation: "new", guidance: "consider", confidence: 0.6,
    evidenceKind: "direct", evidenceRationale: "The originating experiment directly varied regularization.",
  }), config);
  const lessonId = memory.lessons.find((lesson) => lesson.id !== "human-budget")!.id;
  assert.equal(memory.lessons.find((lesson) => lesson.id === lessonId)?.status, "tentative");

  memory = applyExperimentKnowledge(memory, experiment("exp-0002", 2, [lessonId], ["question-0001"]), {
    ...conclusion({
    lessonId, claim: "Regularization improves validation loss", relation: "supports", guidance: "consider", confidence: 0.8,
    evidenceKind: "direct", evidenceRationale: "A pre-registered follow-up reproduced the effect.",
    }),
    questionUpdates: [{ questionId: "question-0001", status: "resolved", resolution: "The follow-up tested it." }],
  }, config);
  assert.equal(memory.lessons.find((lesson) => lesson.id === lessonId)?.status, "supported");

  memory = applyExperimentKnowledge(memory, experiment("exp-0003", 3, [lessonId]), conclusion({
    lessonId, claim: "Regularization improves validation loss", relation: "contradicts", guidance: "verify", confidence: 0.7,
    evidenceKind: "direct", evidenceRationale: "The pre-registered counterexample reversed the effect.",
  }), config);
  assert.equal(memory.lessons.find((lesson) => lesson.id === lessonId)?.status, "contradicted");

  memory = applyExperimentKnowledge(memory, experiment("exp-0004", 4, [lessonId]), conclusion({
    lessonId, claim: "Regularization improves validation loss", relation: "retire", guidance: "avoid", confidence: 0.9,
    evidenceKind: "direct", evidenceRationale: "The scoped claim is no longer useful.",
  }), config);
  assert.equal(memory.lessons.find((lesson) => lesson.id === lessonId)?.status, "retired");
  assert.equal(memory.notes.filter((note) => note.phase === "proposal").length, 4);
  assert.equal(memory.notes.filter((note) => note.phase === "conclusion").length, 8);
  assert.equal(memory.questions.length, 1);
  assert.equal(memory.questions[0]?.status, "resolved");
  assert.equal(memory.questions[0]?.resolvedBy, "exp-0002");
  assert.equal(memory.evidenceReviews.filter((review) => review.accepted).length, 4);
});

test("human-approved lessons remain immutable to agent evidence updates", () => {
  let memory = createResearchMemory(config, "2026-01-01T00:00:00.000Z");
  memory = applyExperimentKnowledge(memory, experiment("exp-0001", 1), conclusion({
    lessonId: "human-budget", claim: "Increase compute without limit", relation: "contradicts", guidance: "consider", confidence: 1,
    evidenceKind: "direct", evidenceRationale: "Attempted override.",
  }), config);
  const lesson = memory.lessons.find((candidate) => candidate.id === "human-budget")!;
  assert.equal(lesson.status, "human-approved");
  assert.equal(lesson.claim, "Keep the compute budget fixed");
  assert.deepEqual(lesson.evidenceFor, ["human"]);
  assert.deepEqual(lesson.evidenceAgainst, []);
  assert.equal(memory.evidenceReviews.at(-1)?.accepted, false);
});

test("contextual or non-preregistered observations do not change lesson evidence", () => {
  let memory = createResearchMemory(config, "2026-01-01T00:00:00.000Z");
  memory = applyExperimentKnowledge(memory, experiment("exp-0001", 1), conclusion({
    claim: "More depth helps", relation: "new", guidance: "consider", confidence: 0.6,
    evidenceKind: "direct", evidenceRationale: "Originating depth comparison.",
  }), config);
  const lessonId = memory.lessons.find((lesson) => lesson.id !== "human-budget")!.id;
  memory = applyExperimentKnowledge(memory, experiment("exp-0002", 2), conclusion({
    lessonId, claim: "More depth helps", relation: "supports", guidance: "consider", confidence: 0.9,
    evidenceKind: "contextual", evidenceRationale: "The model still used depth but did not compare it.",
  }), config);
  assert.deepEqual(memory.lessons.find((lesson) => lesson.id === lessonId)?.evidenceFor, ["exp-0001"]);
  assert.equal(memory.evidenceReviews.at(-1)?.accepted, false);
  assert.match(memory.evidenceReviews.at(-1)?.reason ?? "", /Only direct/);
});

test("a preregistered paired fresh-seed replication can support an existing lesson", () => {
  let memory = createResearchMemory(config, "2026-01-01T00:00:00.000Z");
  memory = applyExperimentKnowledge(memory, experiment("exp-0001", 1), conclusion({
    claim: "More depth helps", relation: "new", guidance: "consider", confidence: 0.6,
    evidenceKind: "direct", evidenceRationale: "Originating depth comparison.",
  }), config);
  const lessonId = memory.lessons.find((lesson) => lesson.id !== "human-budget")!.id;
  const replication = experiment("exp-0002", 2, [lessonId]);
  replication.duplicateOf = "exp-0001";
  replication.pairedEvaluation = {
    referenceId: "baseline",
    seeds: [59, 71, 89],
    rationale: "Fresh-seed confirmation",
    reference: { ok: true, attempts: [], aggregatedMetrics: { loss: 1 } },
    candidate: { ok: true, attempts: [], aggregatedMetrics: { loss: 0.5 } },
    decision: { status: "promote", primaryDelta: 0.5, reasons: ["confirmed"] },
  };
  memory = applyExperimentKnowledge(memory, replication, conclusion({
    lessonId, claim: "More depth helps", relation: "supports", guidance: "consider", confidence: 0.8,
    evidenceKind: "replication", evidenceRationale: "The harness compared the same checkpoint on fresh paired seeds.",
  }), config);
  assert.equal(memory.lessons.find((lesson) => lesson.id === lessonId)?.status, "supported");
  assert.equal(memory.evidenceReviews.at(-1)?.accepted, true);
  assert.match(memory.evidenceReviews.at(-1)?.reason ?? "", /fresh-seed replication/);
});

test("claim normalization preserves Polish letters for stable deduplication", () => {
  assert.equal(normalizeClaim("Większy model — niższy błąd!"), "większy model niższy błąd");
});

test("a skipped duplicate invalidates the addressed question instead of scheduling it forever", () => {
  let memory = createResearchMemory(config, "2026-01-01T00:00:00.000Z");
  memory = applyExperimentKnowledge(memory, experiment("exp-0001", 1), conclusion({
    claim: "Degree three improves loss", relation: "new", guidance: "consider", confidence: 0.7,
    evidenceKind: "direct", evidenceRationale: "The originating experiment tested degree three.",
  }), config);

  const duplicate: ExperimentRecord = {
    ...experiment("exp-0002", 2),
    duplicateOf: "exp-0001",
    targetQuestionId: "question-0001",
    evaluation: {
      ok: false,
      skipped: true,
      attempts: [],
      aggregatedMetrics: {},
      error: "Skipped duplicate workspace already evaluated as exp-0001",
    },
    decision: {
      status: "discard",
      primaryDelta: null,
      reasons: ["Skipped duplicate workspace already evaluated as exp-0001"],
    },
  };
  memory = applyExperimentKnowledge(memory, duplicate, undefined, config);

  assert.equal(memory.questions[0]?.status, "invalidated");
  assert.equal(memory.questions[0]?.resolvedBy, "exp-0002");
  assert.match(memory.questions[0]?.resolution ?? "", /duplicates workspace exp-0001/);
});
