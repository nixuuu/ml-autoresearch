import assert from "node:assert/strict";
import { test } from "bun:test";
import { isAgentVisiblePath, parseExperimentPlan, parseResearchConclusion } from "../src/pi-researcher.js";

test("Pi protocol parses a structured proposal while preserving narrative", () => {
  const narrative = `Changed the regularization.\n<experiment_proposal>\n{"hypothesis":"Regularization reduces loss","changeCategory":"degree3_ridge_tuning","expectedEffect":"lower loss","notes":["The current coefficient is zero"],"lessonsUsed":["lesson-1"],"contradictedLessons":[]}\n</experiment_proposal>`;
  assert.deepEqual(parseExperimentPlan(narrative), {
    hypothesis: "Regularization reduces loss",
    changeCategory: "regularization",
    expectedEffect: "lower loss",
    notes: ["The current coefficient is zero"],
    lessonsUsed: ["lesson-1"],
    contradictedLessons: [],
    lessonTests: [],
    questionsAddressed: [],
  });
});

test("Pi protocol parses a bounded paired evaluation request", () => {
  const narrative = `<experiment_proposal>{"hypothesis":"Confirm the candidate","changeCategory":"evaluation","expectedEffect":"robust gain","notes":[],"lessonsUsed":[],"contradictedLessons":[],"lessonTests":[],"questionsAddressed":[],"evaluationRequest":{"mode":"paired","seeds":[59,71,89],"rationale":"Check the leader and candidate on identical fresh seeds"}}</experiment_proposal>`;
  assert.deepEqual(parseExperimentPlan(narrative)?.evaluationRequest, {
    mode: "paired",
    seeds: [59, 71, 89],
    rationale: "Check the leader and candidate on identical fresh seeds",
  });
});

test("hidden holdout paths are excluded from agent tools", () => {
  assert.equal(isAgentVisiblePath("evaluate.py", ["holdout.py", "private"]), true);
  assert.equal(isAgentVisiblePath("holdout.py", ["holdout.py", "private"]), false);
  assert.equal(isAgentVisiblePath("private/labels.json", ["holdout.py", "private"]), false);
});

test("Pi protocol keeps free-form notes separate from evidence updates", () => {
  const narrative = `<experiment_conclusion>{"summary":"Loss fell","notes":["Optimizer looked stable"],"lessonUpdates":[{"claim":"Regularization helps","relation":"new","guidance":"consider","confidence":0.8}],"nextHypotheses":["Try a smaller coefficient"]}</experiment_conclusion>`;
  const conclusion = parseResearchConclusion(narrative);
  assert.deepEqual(conclusion.notes, ["Optimizer looked stable"]);
  assert.equal(conclusion.lessonUpdates[0]?.relation, "new");
  assert.equal(conclusion.lessonUpdates[0]?.evidenceKind, "contextual");
  assert.deepEqual(conclusion.questionUpdates, []);
  assert.deepEqual(conclusion.nextHypotheses, ["Try a smaller coefficient"]);
});
