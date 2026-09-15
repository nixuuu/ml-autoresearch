import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { AutoresearchHarness } from "../src/harness.js";
import { DirectedResearcher, type ResearchDirector } from "../src/directed-researcher.js";
import { PiResearchDirector, parseDirectorBrief, type DirectorChatFactory } from "../src/pi-director.js";
import { buildPrompt, PiResearcher, type PiResearcherOptions } from "../src/pi-researcher.js";
import { RecoverableResearcherError } from "../src/research-errors.js";
import { AgentTranscriptNormalizer } from "../src/agent-transcript.js";
import { emptyAgentUsage } from "../src/experiment-accounting.js";
import type { ResearchBrief, ResearchConclusion, ResearchContext, ResearchOutcome, ResearchProposal } from "../src/types.js";

const plan = () => ({ hypothesis: "Director's fixed hypothesis", changeCategory: "features" as const,
  expectedEffect: "Improve the held-out score", falsificationCriterion: "No improvement on the fixed metric",
  notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [] });
const brief = (): ResearchBrief => ({ plan: plan(), implementationInstructions: ["Change model.json only"], acceptanceChecks: ["Run final validation"] });
const conclusion = (): ResearchConclusion => ({ narrative: "Director interpretation", summary: "Measured improvement",
  notes: [], lessonUpdates: [], questionUpdates: [], nextHypotheses: ["Director's next experiment"] });
const usage = (requests: number) => ({ ...emptyAgentUsage(), requests, totalTokens: requests * 100, costUsd: requests / 10 });

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "directed-research-"));
  const workspace = path.join(root, "project");
  await mkdir(path.join(workspace, "private"), { recursive: true });
  await writeFile(path.join(workspace, "model.json"), '{"value":1}');
  await writeFile(path.join(workspace, "private", "labels.txt"), "hidden-label");
  const measurements = path.join(root, "measurements.txt");
  await writeFile(path.join(workspace, "evaluate.mjs"), `
import {readFile,writeFile,appendFile} from 'node:fs/promises';
const {value}=JSON.parse(await readFile('model.json','utf8'));
await appendFile(process.env.MEASUREMENT_LOG,process.env.AUTORESEARCH_EXPERIMENT_ID+'\\n');
await writeFile(process.env.AUTORESEARCH_METRICS_PATH,JSON.stringify({metrics:{score:value,complexity:value}}));
`);
  const configPath = path.join(root, "autoresearch.config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, name: "directed-test",
    project: { sourceDir: workspace, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], hiddenPaths: ["private"] },
    agent: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high",
      roles: { director: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high" },
        implementer: { model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" } },
      orchestration: { mode: "directed", maxRevisions: 1, directorMaxAnalysisCalls: 2 } },
    evaluator: { command: [process.execPath, "evaluate.mjs"], repetitions: 1, seeds: [17], timeoutSeconds: 10,
      statistics: { enabled: false },
      env: { MEASUREMENT_LOG: measurements }, runner: { mode: "local" } },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1 } },
    budget: { maxExperiments: 1 }, outputDir: path.join(root, "runs"), researchInstructions: "A controlled test",
    ...extra,
  }));
  return { root, workspace, measurements, configPath, config: await loadConfig(configPath) };
}

function fakeDirector(overrides: Partial<ResearchDirector> = {}): ResearchDirector {
  return { plan: async () => brief(), review: async () => ({ approved: true, summary: "Conforms to brief", concerns: [] }),
    reflect: async () => conclusion(), getUsage: () => usage(3), dispose() {}, ...overrides };
}

test("directed harness routes plan, bounded rework, trusted measurement and reflection to the correct actors", async () => {
  const f = await fixture();
  const order: string[] = [];
  let workerReflections = 0;
  let directorOutcome: ResearchOutcome | undefined;
  let reviews = 0;
  const state = await new AutoresearchHarness(f.config, async (workspace, experimentDir, profile) => {
    assert.equal(profile!.model, "openai-codex/gpt-5.6-luna");
    assert.equal(profile!.thinkingLevel, "max");
    return new DirectedResearcher(
    f.config, workspace, experimentDir,
    fakeDirector({
      plan: async () => { order.push("astra-plan"); return brief(); },
      review: async (_context, frozen, proposal) => {
        order.push("astra-review");
        assert.equal(frozen.plan.hypothesis, plan().hypothesis);
        assert.equal(proposal.plan!.hypothesis, "Worker's own report");
        reviews += 1;
        return { approved: reviews === 2, summary: reviews === 1 ? "Correct the implementation" : "Approved", concerns: [] };
      },
      reflect: async (_context, _brief, outcome) => { order.push("astra-reflect"); directorOutcome = outcome; return conclusion(); },
    }),
    async (attempt) => ({
      async propose(context) {
        order.push(`luna-${attempt}`);
        assert.equal(context.researchBrief!.plan.hypothesis, plan().hypothesis);
        if (attempt === 1) assert.equal(context.implementationFeedback!.summary, "Correct the implementation");
        context.researchBrief!.plan.hypothesis = "must not mutate the saved director brief";
        await writeFile(path.join(workspace, "model.json"), JSON.stringify({ value: attempt + 2 }));
        return { narrative: "Implementation details", plan: { ...plan(), hypothesis: "Worker's own report", analysisEvidence: [`fresh-${attempt}`] } };
      },
      async reflect() { workerReflections += 1; return conclusion(); },
      getUsage: () => usage(1), dispose() { order.push(`dispose-luna-${attempt}`); },
    }),
  ); }).run({ configPath: f.configPath });
  assert.deepEqual(order, ["astra-plan", "luna-0", "dispose-luna-0", "astra-review", "luna-1", "dispose-luna-1", "astra-review", "astra-reflect"]);
  assert.equal(workerReflections, 0);
  assert.equal(directorOutcome!.evaluation.aggregatedMetrics.score, 3);
  assert.equal(directorOutcome!.decision.status, "promote");
  assert.equal(state.acceptedMetrics.score, 3);
  assert.equal(state.experiments[0]!.plan!.hypothesis, plan().hypothesis);
  assert.deepEqual(state.experiments[0]!.plan!.analysisEvidence, ["fresh-1"]);
  assert.equal(state.experiments[0]!.accounting.agentUsage.requests, 5);
  assert.equal(state.experiments[0]!.proposalReview!.approved, true);
  assert.equal((await readFile(f.measurements, "utf8")).trim().split("\n").length, 2);
});

test("exhausted director review does not invoke the candidate evaluator", async () => {
  const f = await fixture();
  let attempts = 0;
  const state = await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector({ review: async () => ({ approved: false, summary: "Still confounded", concerns: ["Separate changes"] }),
      reflect: async (_context, _brief, outcome) => { assert.equal(outcome.evaluation.skipped, true); return { ...conclusion(), summary: "Implementation rejected" }; } }),
    async () => ({ propose: async () => { attempts += 1; await writeFile(path.join(workspace, "model.json"), '{"value":3}'); return { narrative: "worker", plan: plan() }; } }),
  )).run({ configPath: f.configPath });
  assert.equal(attempts, 2);
  assert.equal(state.experiments[0]!.decision.status, "discard");
  assert.equal(state.experiments[0]!.conclusion!.summary, "Implementation rejected");
  assert.equal(state.acceptedMetrics.score, 1);
  assert.equal((await readFile(f.measurements, "utf8")).trim().split("\n").length, 1);
});

test("director reflection failure preserves measured metrics but blocks promotion", async () => {
  const f = await fixture();
  const state = await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector({ reflect: async () => { throw new Error("Director unavailable"); } }),
    async () => ({ propose: async () => { await writeFile(path.join(workspace, "model.json"), '{"value":3}'); return { narrative: "worker", plan: plan() }; } }),
  )).run({ configPath: f.configPath });
  assert.equal(state.experiments[0]!.evaluation.aggregatedMetrics.score, 3);
  assert.equal(state.experiments[0]!.decision.status, "failure");
  assert.equal(state.acceptedMetrics.score, 1);
  assert.match(state.experiments[0]!.decision.reasons.join(" "), /director reflection failed/);
});

test("director acceptance cannot override failed implementer validation", async () => {
  const f = await fixture();
  const state = await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector(), async () => ({ propose: async () => { throw new RecoverableResearcherError("Canonical test failed"); } }),
  )).run({ configPath: f.configPath });
  assert.equal(state.experiments[0]!.decision.status, "discard");
  assert.equal(state.experiments[0]!.proposalReview!.approved, false);
  assert.equal((await readFile(f.measurements, "utf8")).trim().split("\n").length, 1);
});

test("a director cannot change even a mutable candidate file during planning", async () => {
  const f = await fixture();
  let workers = 0;
  const state = await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector({ plan: async () => { await writeFile(path.join(workspace, "model.json"), '{"value":9}'); return brief(); } }),
    async () => { workers += 1; throw new Error("unreachable"); },
  )).run({ configPath: f.configPath });
  assert.equal(workers, 0);
  assert.equal(state.acceptedMetrics.score, 1);
  assert.match(state.experiments[0]!.decision.reasons.join(" "), /Director planning mutated/);
});

test("director approval cannot override evaluator guardrails", async () => {
  const f = await fixture({ metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1 },
    guardrails: [{ name: "complexity", direction: "minimize", max: 2 }] } });
  const state = await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector(), async () => ({ propose: async () => { await writeFile(path.join(workspace, "model.json"), '{"value":3}'); return { narrative: "worker", plan: plan() }; } }),
  )).run({ configPath: f.configPath });
  assert.equal(state.experiments[0]!.proposalReview!.approved, true);
  assert.equal(state.experiments[0]!.decision.status, "discard");
  assert.equal(state.acceptedMetrics.score, 1);
});

test("planning is not bypassed by a deterministic search assignment", async () => {
  const f = await fixture({ search: { enabled: true, parameters: [{ name: "value", file: "model.json", path: "value", type: "integer", min: 1, max: 4 }] },
    learning: { strategy: { optimizeRate: 1, explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, mergeRate: 0, ablationRate: 0 } },
    budget: { maxExperiments: 2 } });
  let planned = 0;
  await new AutoresearchHarness(f.config, async (workspace, dir) => new DirectedResearcher(f.config, workspace, dir,
    fakeDirector({ plan: async () => { planned += 1; return { ...brief(), plan: { ...plan(), hypothesis: `Plan ${planned}` } }; } }),
    async () => ({ propose: async () => { await writeFile(path.join(workspace, "model.json"), JSON.stringify({ value: planned + 1 })); return { narrative: "worker", plan: plan() }; } }),
  )).run({ configPath: f.configPath });
  assert.equal(planned, 2);
});

test("worker transcript attempt namespaces prevent entry collisions", () => {
  const first = new AgentTranscriptNormalizer("implementer", "implementation-0").status("proposal", "start");
  const second = new AgentTranscriptNormalizer("implementer", "implementation-1").status("proposal", "start");
  assert.notEqual(first.entryId, second.entryId);
});

test("directed config requires explicit supported roles and serial backend", async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.configPath, "utf8"));
  for (const [mutate, pattern] of [
    [(raw: any) => { delete raw.agent.roles.director; }, /requires agent.roles.director/],
    [(raw: any) => { delete raw.agent.roles.implementer; }, /requires an implementer model/],
    [(raw: any) => { raw.agent.roles.reviewer = { model: "openai-codex/gpt-6-astra" }; }, /omit agent.roles.reviewer/],
    [(raw: any) => { raw.execution = { experimentConcurrency: 2 }; }, /experimentConcurrency=1/],
    [(raw: any) => { raw.agent.backend = { type: "prime-agent-rpc", command: ["prime-agent"], runner: { mode: "docker", image: "test" } }; }, /requires the pi-sdk backend/],
    [(raw: any) => { raw.agent.orchestration.mode = "adaptive"; }, /director requires orchestration.mode=directed/],
  ] as const) {
    const raw = structuredClone(original);
    mutate(raw);
    await writeFile(f.configPath, JSON.stringify(raw));
    await assert.rejects(loadConfig(f.configPath), pattern);
  }
});

function contextFor(f: Awaited<ReturnType<typeof fixture>>): ResearchContext {
  return {
    experimentId: "exp-0001", experimentIndex: 1, workspacePath: f.workspace,
    mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], primaryMetric: f.config.metrics.primary,
    guardrails: [], acceptedMetrics: { score: 1 },
    assignment: { strategy: "exploit", parentId: "baseline", parentWorkspacePath: f.workspace,
      parentMetrics: { score: 1 }, branchDepth: 0, reason: "Test" },
    memory: { lessons: [], questions: [], facts: [], notes: [] }, previousExperiments: [], researchInstructions: "Use the supplied data",
    evaluationRequests: { allowPairedComparison: false, maxSeeds: 1, canonicalSeeds: [17], allowParameterSweep: false, maxSweepValues: 0, sweepParameters: [] },
    analysis: { enabled: true, runner: "local", maxCalls: 5, finalValidationReserve: 0, timeoutSeconds: 10,
      runtime: { pythonCommand: [process.execPath], projectPathEntries: ["."] }, jobsEnabled: false,
      requireFreshEvidenceAfterMutation: true, dependencies: { enabled: false, allowedManagers: [], environmentProfiles: [] } },
  } as ResearchContext;
}

test("director gets the requested model, bounded fresh analysis mirrors and no hidden-file tools", async () => {
  const f = await fixture();
  const raw = JSON.parse(await readFile(f.configPath, "utf8"));
  raw.agent.analysis = { enabled: true, maxCalls: 5, timeoutSeconds: 10,
    runtime: { pythonCommand: [process.execPath], projectPathEntries: ["."] },
    runner: { mode: "local", allowHostExecution: true }, jobs: { enabled: false } };
  await writeFile(f.configPath, JSON.stringify(raw));
  f.config = await loadConfig(f.configPath);
  const values: number[] = [];
  let factoryCalls = 0;
  const factory: DirectorChatFactory = async (options) => {
    factoryCalls += 1;
    assert.equal(options.profile.model, "openai-codex/gpt-6-astra");
    assert.equal(options.profile.thinkingLevel, "high");
    assert.ok(options.tools.every((tool) => !/write|replace|add_dependency|exec_start/.test(tool.name)));
    const call = async (name: string, params: object) => {
      const tool = options.tools.find((item) => item.name === name)!;
      return (tool.execute as any)("test", params);
    };
    return { async prompt(_text, phase) {
      if (phase === "planning") {
        const hidden = await call("director_read", { path: "private/labels.txt" });
        assert.equal(hidden.details.isError, true);
        assert.doesNotMatch(hidden.content[0].text, /hidden-label/);
        const listing = await call("director_list", {});
        assert.doesNotMatch(listing.content[0].text, /private/);
      }
      const execution = await call("director_exec", { command: [process.execPath, "-e",
        "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('model.json')).value);fs.writeFileSync('model.json',JSON.stringify({value:99}));"] });
      if (phase === "reflection") {
        assert.equal(execution.details.isError, true);
        assert.match(execution.content[0].text, /budget exhausted/);
        return `<experiment_conclusion>${JSON.stringify({ ...conclusion(), methodUpdates: [] })}</experiment_conclusion>`;
      }
      values.push(Number(JSON.parse(execution.content[0].text).stdout.trim()));
      return phase === "planning"
        ? `<research_brief>${JSON.stringify(brief())}</research_brief>`
        : '<proposal_review>{"approved":true,"summary":"Valid","concerns":[]}</proposal_review>';
    }, getUsage: () => usage(3), dispose() {} };
  };
  const director = new PiResearchDirector(f.config, f.workspace, path.join(f.root, "experiment"), factory);
  const context = contextFor(f);
  const planned = await director.plan(context);
  assert.equal(JSON.parse(await readFile(path.join(f.workspace, "model.json"), "utf8")).value, 1);
  await writeFile(path.join(f.workspace, "model.json"), '{"value":2}');
  await director.review(context, planned, { narrative: "worker", plan: plan() }, ["model.json"]);
  await director.reflect(context, planned, { experimentId: context.experimentId, changedPaths: ["model.json"],
    acceptedMetricsBefore: { score: 1 }, parentMetrics: { score: 1 }, assignment: context.assignment,
    plan: planned.plan, evaluation: { ok: true, aggregatedMetrics: { score: 2 }, trials: [] },
    decision: { status: "promote", reasons: ["Measured gain"] } } as ResearchOutcome);
  assert.deepEqual(values, [1, 2]);
  assert.equal(JSON.parse(await readFile(path.join(f.workspace, "model.json"), "utf8")).value, 2);
  assert.equal(factoryCalls, 1);
  assert.equal(director.getUsage().requests, 3);
  director.dispose();
});

test("director protocol rejects incomplete scientific briefs and invented evidence", async () => {
  const f = await fixture();
  const context = contextFor(f);
  assert.throws(() => parseDirectorBrief('<research_brief>{"plan":{}}</research_brief>', context), /hypothesis/);
  const invented = brief();
  invented.plan.lessonTests = ["unknown-lesson"];
  assert.throws(() => parseDirectorBrief(`<research_brief>${JSON.stringify(invented)}</research_brief>`, context), /unknown lesson/);
  const valid = brief();
  valid.plan.analysisEvidence = ["invented-post-edit-evidence"];
  assert.equal(parseDirectorBrief(`<research_brief>${JSON.stringify(valid)}</research_brief>`, context).plan.analysisEvidence, undefined);
});

test("director protocol repair is bounded and does not fall back to another model", async () => {
  const f = await fixture();
  let calls = 0;
  const director = new PiResearchDirector(f.config, f.workspace, path.join(f.root, "director"), async () => ({
    async prompt() { calls += 1; return "No protocol block"; }, getUsage: () => usage(calls), dispose() {},
  }));
  await assert.rejects(director.plan(contextFor(f)), /Director planning protocol failed/);
  assert.equal(calls, 2);
  director.dispose();
});

test("director and implementer can see every active backlog ticket beyond the old prompt cap", async () => {
  const f = await fixture();
  const context = contextFor(f);
  const now = new Date().toISOString();
  context.campaign = { schemaVersion: 1, id: "campaign-test", goal: "Explore", createdAt: now, updatedAt: now,
    tickets: Array.from({ length: 125 }, (_, index) => ({
      id: `ticket-${index}`, kind: "hypothesis", hypothesis: `Distinct research idea ${index}.`, status: "queued",
      createdBy: "agent", createdAt: now, updatedAt: now, dependencies: [], expectedGain: 0,
      probabilityOfSuccess: 0.5, informationGain: 0.5, estimatedCost: 1, priority: 0.5,
    })),
  };
  let directorPrompt = "";
  const director = new PiResearchDirector(f.config, f.workspace, path.join(f.root, "director"), async () => ({
    async prompt(prompt) { directorPrompt = prompt; return `<research_brief>${JSON.stringify(brief())}</research_brief>`; },
    getUsage: () => usage(1), dispose() {},
  }));
  try {
    await director.plan(context);
    const workerPrompt = buildPrompt(context);
    for (const ticket of context.campaign.tickets) {
      assert.ok(directorPrompt.includes(ticket.hypothesis));
      assert.ok(workerPrompt.includes(ticket.hypothesis));
    }
  } finally { director.dispose(); }
});

test("a fresh worker session must validate even when it leaves the candidate unchanged", async () => {
  for (const exitCode of [0, 7]) {
    const f = await fixture();
    const raw = JSON.parse(await readFile(f.configPath, "utf8"));
    raw.agent.analysis = { enabled: true, maxCalls: 5, minimumCallsBeforeProposal: 0, finalValidationReserve: 2,
      runtime: { pythonCommand: [process.execPath], projectPathEntries: ["."],
        testCommand: [process.execPath, "-e", `process.exit(${exitCode})`] },
      runner: { mode: "local", allowHostExecution: true }, evidence: { requireFreshAfterMutation: true } };
    await writeFile(f.configPath, JSON.stringify(raw));
    f.config = await loadConfig(f.configPath);
    const context = contextFor(f);
    context.analysis.runtime.testCommand = raw.agent.analysis.runtime.testCommand;
    context.analysis.finalValidationReserve = 2;
    const listeners = new Set<(event: unknown) => void>();
    const createSession: NonNullable<PiResearcherOptions["createSession"]> = async (options) => {
      assert.equal(options!.model!.id, "gpt-5.6-luna");
      assert.equal(options!.thinkingLevel, "max");
      return { session: {
        model: options!.model, thinkingLevel: options!.thinkingLevel, agent: { state: {} },
        subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async prompt() {
          for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: {
            type: "text_delta", contentIndex: 0, delta: `<experiment_proposal>${JSON.stringify(plan())}</experiment_proposal>` } });
        },
        getSessionStats() { return { assistantMessages: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }; },
        dispose() {},
      } } as any;
    };
    const experiment = path.join(f.root, "implementation");
    const worker = new PiResearcher(f.config, f.workspace, experiment, f.config.agent.roles!.implementer, undefined,
      { requireFinalValidation: true, createSession });
    try {
      if (exitCode === 0) {
        const proposal = await worker.propose(context);
        assert.deepEqual(proposal.plan!.analysisEvidence, ["evidence-0001"]);
      } else {
        await assert.rejects(worker.propose(context), /final candidate validation.*failed with exit=7/);
      }
      const log = await readFile(path.join(experiment, "analysis", "commands.jsonl"), "utf8");
      assert.match(log, /analysis_command_completed/);
      assert.equal(JSON.parse(await readFile(path.join(f.workspace, "model.json"), "utf8")).value, 1);
    } finally {
      await worker.dispose();
    }
  }
});
