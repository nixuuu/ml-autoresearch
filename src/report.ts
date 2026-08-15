import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResearchDecisionStatus, RunState } from "./types.js";
import { loadConfig } from "./config.js";
import { migrateResearchMemory } from "./research-memory.js";
import { primaryImprovement } from "./research-strategy.js";

function metricTable(metrics: Record<string, number>): string {
  return Object.entries(metrics).map(([name, value]) => `| ${name} | ${value} |`).join("\n");
}

function decisionStatus(status: RunState["experiments"][number]["decision"]["status"]): ResearchDecisionStatus {
  return status === "keep" ? "promote" : status === "reject" ? "discard" : status;
}

function computeBestObserved(state: RunState): NonNullable<RunState["bestObserved"]> | undefined {
  if (!state.primaryMetric || !state.baseline.ok) return state.bestObserved;
  let best: NonNullable<RunState["bestObserved"]> = {
    experimentId: "baseline",
    workspacePath: path.join(state.runDir, "baseline", "workspace"),
    metrics: state.baseline.aggregatedMetrics,
    decisionStatus: "baseline",
  };
  for (const experiment of state.experiments) {
    if (!experiment.evaluation.ok) continue;
    if (primaryImprovement(best.metrics, experiment.evaluation.aggregatedMetrics, state.primaryMetric) <= 0) continue;
    best = {
      experimentId: experiment.id,
      workspacePath: experiment.workspacePath,
      metrics: experiment.evaluation.aggregatedMetrics,
      decisionStatus: decisionStatus(experiment.decision.status),
    };
  }
  return best;
}

function mermaidText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "'")
    .replaceAll("\n", " ");
}

function mermaidId(id: string): string {
  return `N${id.replace(/[^A-Za-z0-9]/g, "")}`;
}

function renderResearchGraph(state: RunState): string {
  const primaryName = state.primaryMetric?.name ?? Object.keys(state.acceptedMetrics)[0] ?? "primary";
  const graphNodes = new Map(state.researchGraph?.nodes.map((node) => [node.id, node]) ?? []);
  const lines = ["flowchart TD"];
  const baselineStatus = graphNodes.get("baseline")?.status ?? (state.researchGraph?.leaderId === "baseline" ? "leader" : "retired");
  lines.push(`  ${mermaidId("baseline")}["baseline<br/>${mermaidText(primaryName)}=${mermaidText(state.baseline.aggregatedMetrics[primaryName] ?? "n/a")}<br/>${baselineStatus}"]`);

  for (const experiment of state.experiments) {
    const graphNode = graphNodes.get(experiment.id);
    const topologyStatus = graphNode?.status ?? (experiment.strategy === "replicate" || (experiment.pairedEvaluation && experiment.duplicateOf) ? "audit-only" : "not-in-frontier");
    const primaryValue = experiment.evaluation.aggregatedMetrics[primaryName];
    const category = experiment.plan?.changeCategory ?? "other";
    const paired = experiment.pairedEvaluation ? `<br/>paired=${mermaidText(experiment.pairedEvaluation.decision.status)}` : "";
    lines.push(`  ${mermaidId(experiment.id)}["${experiment.id}<br/>${mermaidText(category)}<br/>${mermaidText(primaryName)}=${mermaidText(primaryValue ?? "n/a")}${paired}<br/>${mermaidText(experiment.decision.status)} → ${mermaidText(topologyStatus)}"]`);
  }
  for (const experiment of state.experiments) {
    const parentId = experiment.parentId ?? "baseline";
    const connector = experiment.strategy === "replicate" || (experiment.pairedEvaluation && experiment.duplicateOf) ? "-.->" : "-->";
    lines.push(`  ${mermaidId(parentId)} ${connector}|"${mermaidText(experiment.strategy ?? "legacy")}"| ${mermaidId(experiment.id)}`);
  }

  lines.push(
    "  classDef leader fill:#bbf7d0,stroke:#166534,color:#14532d;",
    "  classDef frontier fill:#bfdbfe,stroke:#1d4ed8,color:#1e3a8a;",
    "  classDef retired fill:#f3f4f6,stroke:#6b7280,color:#374151;",
    "  classDef discarded fill:#fecaca,stroke:#b91c1c,color:#7f1d1d;",
    "  classDef audit fill:#fef3c7,stroke:#a16207,color:#713f12;",
  );
  const classGroups = new Map<string, string[]>();
  const addClass = (className: string, id: string) => classGroups.set(className, [...(classGroups.get(className) ?? []), mermaidId(id)]);
  addClass(baselineStatus === "leader" ? "leader" : baselineStatus === "frontier" ? "frontier" : "retired", "baseline");
  for (const experiment of state.experiments) {
    const status = graphNodes.get(experiment.id)?.status;
    if (status === "leader") addClass("leader", experiment.id);
    else if (status === "frontier") addClass("frontier", experiment.id);
    else if (status === "discarded" || status === "failed") addClass("discarded", experiment.id);
    else if (experiment.strategy === "replicate" || (experiment.pairedEvaluation && experiment.duplicateOf)) addClass("audit", experiment.id);
    else addClass("retired", experiment.id);
  }
  for (const [className, ids] of classGroups) lines.push(`  class ${ids.join(",")} ${className};`);
  return `\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``;
}

async function hydrateLegacyState(state: RunState): Promise<RunState> {
  const hydrated = { ...state };
  if (state.researchMemory) hydrated.researchMemory = migrateResearchMemory(state.researchMemory);
  if (!hydrated.primaryMetric) {
    try {
      const config = await loadConfig(hydrated.configPath);
      hydrated.primaryMetric ??= config.metrics.primary;
    } catch {
      // Old reports remain renderable even when their original config moved.
    }
  }
  const bestObserved = computeBestObserved(hydrated);
  if (bestObserved) hydrated.bestObserved = bestObserved;
  return hydrated;
}

export async function renderReport(inputState: RunState): Promise<string> {
  const state = await hydrateLegacyState(inputState);
  const rows = state.experiments.map((experiment) => {
    const metrics = Object.entries(experiment.evaluation.aggregatedMetrics).map(([name, value]) => `${name}=${value}`).join(", ") || "—";
    const paired = experiment.pairedEvaluation
      ? `${experiment.pairedEvaluation.decision.status} vs ${experiment.pairedEvaluation.referenceId} (seeds ${experiment.pairedEvaluation.seeds.join(",")})`
      : "—";
    return `| ${experiment.id} | ${experiment.parentId ?? "—"} | ${experiment.strategy ?? "legacy"} | ${experiment.plan?.changeCategory ?? "other"} | ${experiment.decision.status} | ${experiment.decision.primaryDelta ?? "—"} | ${metrics} | ${paired} | ${experiment.changedPaths.join(", ") || "—"} |`;
  }).join("\n");
  const promoted = state.experiments.filter((experiment) => experiment.decision.status === "promote" || experiment.decision.status === "keep").length;
  const retained = state.experiments.filter((experiment) => experiment.decision.status === "retain").length;
  const discarded = state.experiments.filter((experiment) => experiment.decision.status === "discard" || experiment.decision.status === "reject").length;
  const failed = state.experiments.filter((experiment) => experiment.decision.status === "failure").length;
  const details = state.experiments.map((experiment) => `### ${experiment.id}: ${experiment.decision.status}

- Parent: ${experiment.parentId ?? "legacy accepted workspace"}
- Strategy: ${experiment.strategy ?? "legacy"}
- Normalized change category: ${experiment.plan?.changeCategory ?? "other"}
- Branch depth: ${experiment.branchDepth ?? "—"}
- Hypothesis: ${experiment.plan?.hypothesis ?? "—"}
- Questions addressed: ${experiment.plan?.questionsAddressed?.join(", ") || "—"}
- Pre-registered lesson tests: ${experiment.plan?.lessonTests?.join(", ") || "—"}
- Evaluation request: ${experiment.plan?.evaluationRequest ? `paired comparison on fresh seeds ${experiment.plan.evaluationRequest.seeds.join(", ")} — ${experiment.plan.evaluationRequest.rationale}` : "canonical only"}
- Paired result: ${experiment.pairedEvaluation ? `${experiment.pairedEvaluation.decision.status} against ${experiment.pairedEvaluation.referenceId}; candidate=${JSON.stringify(experiment.pairedEvaluation.candidate.aggregatedMetrics)}; reference=${JSON.stringify(experiment.pairedEvaluation.reference.aggregatedMetrics)}` : "—"}
- Decision: ${experiment.decision.reasons.join("; ")}
- Proposal: ${experiment.proposalPath ? `[proposal](experiments/${experiment.id}/proposal.md)` : "—"}
- Structured proposal: ${experiment.proposalJsonPath ? `[JSON](experiments/${experiment.id}/proposal.json)` : "—"}
- Conclusion: ${experiment.conclusionPath ? `[conclusion](experiments/${experiment.id}/conclusion.md)` : "—"}
- Structured conclusion: ${experiment.conclusionJsonPath ? `[JSON](experiments/${experiment.id}/conclusion.json)` : "—"}
- Duplicate: ${experiment.duplicateOf ?? experiment.repeatedHypothesisOf ?? "—"}
`).join("\n");
  const memory = state.researchMemory;
  const lessonCounts = memory
    ? Object.fromEntries(["human-approved", "supported", "tentative", "contradicted", "retired"].map((status) => [status, memory.lessons.filter((lesson) => lesson.status === status).length]))
    : {};
  const questionCounts = memory
    ? Object.fromEntries(["open", "resolved", "invalidated"].map((status) => [status, memory.questions.filter((question) => question.status === status).length]))
    : {};
  const frontier = state.researchGraph?.frontierIds.join(", ") || "none";
  const bestObserved = state.bestObserved;
  const bestMatchesLeader = bestObserved?.experimentId === (state.researchGraph?.leaderId ?? "baseline");
  const acceptedArtifact = "[accepted.json](accepted.json)";
  const bestArtifact = "[best-observed.json](best-observed.json)";

  return `# Autoresearch run: ${state.name}

- Run ID: \`${state.runId}\`
- Status: **${state.status}**
- Started: ${state.startedAt}
- Finished: ${state.finishedAt ?? "still running"}
- Stop reason: ${state.stopReason ?? "—"}
- Agent model: \`${state.agent ? state.agent.model ?? "Pi default" : "not recorded in legacy state"}\`
- Agent reasoning/thinking level: \`${state.agent?.thinkingLevel ?? "not recorded in legacy state"}\`
- Experiments: ${state.experiments.length} (${promoted} promoted, ${retained} retained, ${discarded} discarded, ${failed} failed)
- Accepted workspace: \`${state.acceptedWorkspacePath}\`
- Policy leader: \`${state.researchGraph?.leaderId ?? "legacy"}\`
- Best observed result: \`${bestObserved?.experimentId ?? "unknown"}\`${bestMatchesLeader ? " (same as policy leader)" : " (not promoted by policy)"}
- Active frontier: ${frontier}

## Policy-accepted metrics

| Metric | Value |
| --- | ---: |
${metricTable(state.acceptedMetrics)}

Policy artifact: ${acceptedArtifact}

## Best observed metrics

| Metric | Value |
| --- | ---: |
${metricTable(bestObserved?.metrics ?? {}) || "| — | — |"}

- Experiment: \`${bestObserved?.experimentId ?? "unknown"}\`
- Decision at observation time: \`${bestObserved?.decisionStatus ?? "unknown"}\`
- Workspace: \`${bestObserved?.workspacePath ?? "unknown"}\`
- Raw-best artifact: ${bestArtifact} (\`best.json\` is a compatibility alias)

## Experiment graph

The chart is generated from the persisted parent graph and experiment records every time the report is written.

${renderResearchGraph(state)}

## Experiment history

| Experiment | Parent | Strategy | Category | Decision | Primary delta | Canonical metrics | Fresh-seed confirmation | Changed paths |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- |
${rows || "| — | — | — | — | — | — | — | — | — |"}

## Research memory

- Harness facts: ${memory?.facts.length ?? 0}
- Agent notebook entries: ${memory?.notes.length ?? 0}
- Research questions by status: ${JSON.stringify(questionCounts)}
- Lessons by status: ${JSON.stringify(lessonCounts)}
- Evidence reviews: ${memory?.evidenceReviews.length ?? 0} (${memory?.evidenceReviews.filter((review) => review.accepted).length ?? 0} accepted, ${memory?.evidenceReviews.filter((review) => !review.accepted).length ?? 0} rejected)
- Full readable memory: [RESEARCH_MEMORY.md](RESEARCH_MEMORY.md)
- Machine-readable memory: [research-memory.json](research-memory.json)
- Branch graph and frontier: [frontier.json](frontier.json)

## Decisions and conclusions

${details || "No candidate experiments have completed yet."}

## Audit artifacts

- \`events.jsonl\`: normalized append-only run event stream.
- \`experiments/*/pi-events.jsonl\`: complete Pi SDK event streams, including resolved model and effective thinking level.
- \`experiments/*/proposal.json\`: structured hypotheses, normalized categories, question IDs, and pre-registered lesson tests.
- \`experiments/*/conclusion.json\`: agent notes, question resolutions, and proposed evidence updates.
- \`experiments/*/evaluation/\`: evaluator stdout, stderr, metrics, seeds, and timings.
- \`experiments/*/paired-evaluation/\`: optional candidate/reference measurements on identical fresh seeds.
- \`research-memory.json\` and \`RESEARCH_MEMORY.md\`: durable facts, agent notes, lesson evidence audit, and question lifecycle.
- \`frontier.json\`: parent graph, policy leader, and retained alternative checkpoints.
- \`accepted.json\`: policy-accepted leader.
- \`best-observed.json\` and \`best.json\`: lowest/highest raw primary metric observed according to metric direction.
- \`state.json\`: machine-readable current state.
`;
}

export async function writeReport(state: RunState): Promise<string> {
  const reportPath = path.join(state.runDir, "REPORT.md");
  await writeFile(reportPath, await renderReport(state), "utf8");
  return reportPath;
}

export async function regenerateReport(runDir: string): Promise<string> {
  const resolvedRunDir = path.resolve(runDir);
  const state = JSON.parse(await readFile(path.join(resolvedRunDir, "state.json"), "utf8")) as RunState;
  state.runDir = resolvedRunDir;
  return writeReport(state);
}
