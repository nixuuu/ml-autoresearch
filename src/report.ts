import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunState } from "./types.js";

function metricTable(metrics: Record<string, number>): string {
  return Object.entries(metrics).map(([name, value]) => `| ${name} | ${value} |`).join("\n");
}

function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  return Math.abs(value) < 0.0001 ? `$${value.toExponential(4)}` : `$${value.toFixed(4)}`;
}

function formatSeconds(milliseconds: number | null): string {
  return milliseconds === null || !Number.isFinite(milliseconds) ? "—" : `${(milliseconds / 1_000).toFixed(2)}s`;
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
    const pareto = graphNode?.paretoOptimal ? "<br/>★ Pareto" : "";
    lines.push(`  ${mermaidId(experiment.id)}["${experiment.id}<br/>${mermaidText(category)}<br/>${mermaidText(primaryName)}=${mermaidText(primaryValue ?? "n/a")}${paired}${pareto}<br/>${mermaidText(experiment.decision.status)} → ${mermaidText(topologyStatus)}"]`);
  }
  for (const experiment of state.experiments) {
    const parentId = experiment.parentId ?? "baseline";
    const connector = experiment.strategy === "replicate" || (experiment.pairedEvaluation && experiment.duplicateOf) ? "-.->" : "-->";
    lines.push(`  ${mermaidId(parentId)} ${connector}|"${mermaidText(experiment.strategy ?? "unknown")}"| ${mermaidId(experiment.id)}`);
    if (experiment.plan?.merge) {
      lines.push(`  ${mermaidId(experiment.plan.merge.sourceExperimentIds[1])} -.->|"merge source"| ${mermaidId(experiment.id)}`);
    }
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

export async function renderReport(inputState: RunState): Promise<string> {
  const state = inputState;
  const rows = state.experiments.map((experiment) => {
    const metrics = Object.entries(experiment.evaluation.aggregatedMetrics).map(([name, value]) => `${name}=${value}`).join(", ") || "—";
    const paired = experiment.pairedEvaluation
      ? `${experiment.pairedEvaluation.decision.status} vs ${experiment.pairedEvaluation.referenceId} (seeds ${experiment.pairedEvaluation.seeds.join(",")})`
      : "—";
    const evidence = experiment.evaluation.statisticalComparison
      ? `${experiment.evaluation.statisticalComparison.status}, n=${experiment.evaluation.statisticalComparison.sampleCount}, CI=[${experiment.evaluation.statisticalComparison.confidenceInterval.lower}, ${experiment.evaluation.statisticalComparison.confidenceInterval.upper}]`
      : `n=${experiment.evaluation.attempts.length}`;
    return `| ${experiment.id} | ${experiment.parentId ?? "—"} | ${experiment.strategy ?? "unknown"} | ${experiment.plan?.changeCategory ?? "other"} | ${experiment.decision.status} | ${experiment.decision.primaryDelta ?? "—"} | ${formatSeconds(experiment.accounting.durationMs)} | ${formatCost(experiment.accounting.agentUsage.costUsd)} | ${experiment.accounting.costPerImprovementUsd === null ? "—" : formatCost(experiment.accounting.costPerImprovementUsd)} | ${formatSeconds(experiment.accounting.timePerImprovementMs)} | ${metrics} | ${evidence} | ${paired} | ${experiment.changedPaths.join(", ") || "—"} |`;
  }).join("\n");
  const promoted = state.experiments.filter((experiment) => experiment.decision.status === "promote" || experiment.decision.status === "keep").length;
  const retained = state.experiments.filter((experiment) => experiment.decision.status === "retain").length;
  const discarded = state.experiments.filter((experiment) => experiment.decision.status === "discard" || experiment.decision.status === "reject").length;
  const failed = state.experiments.filter((experiment) => experiment.decision.status === "failure").length;
  const inconclusive = state.experiments.filter((experiment) => experiment.decision.status === "inconclusive").length;
  const pruned = state.experiments.filter((experiment) => experiment.decision.status === "pruned").length;
  const details = state.experiments.map((experiment) => `### ${experiment.id}: ${experiment.decision.status}

- Parent: ${experiment.parentId ?? "unknown"}
- Strategy: ${experiment.strategy ?? "unknown"}
- Normalized change category: ${experiment.plan?.changeCategory ?? "other"}
- Branch depth: ${experiment.branchDepth ?? "—"}
- Hypothesis: ${experiment.plan?.hypothesis ?? "—"}
- Agent profile: ${experiment.agentProfileId ?? "—"}
- Campaign ticket: ${experiment.ticketId ?? "—"}
- Expected gain / probability / information / cost: ${experiment.plan ? `${experiment.plan.expectedGain ?? "—"} / ${experiment.plan.probabilityOfSuccess ?? "—"} / ${experiment.plan.informationGain ?? "—"} / ${experiment.plan.estimatedCost ?? "—"}` : "—"}
- Falsification criterion: ${experiment.plan?.falsificationCriterion ?? "—"}
- Search suggestion: ${experiment.plan?.searchSuggestion ? JSON.stringify(experiment.plan.searchSuggestion) : "—"}
- Ablation: ${experiment.plan?.ablation ? JSON.stringify(experiment.plan.ablation) : "—"}
- Merge: ${experiment.plan?.merge ? JSON.stringify(experiment.plan.merge) : "—"}
- Proposal review: ${experiment.proposalReview ? `${experiment.proposalReview.approved ? "approved" : "rejected"} — ${experiment.proposalReview.summary}` : "—"}
- Evaluation stages: ${experiment.evaluation.stages?.map((stage) => `${stage.name}@${stage.budgetRatio}: n=${stage.attempts.length}, ${stage.pruned ? "pruned" : stage.comparison?.status ?? (stage.ok ? "complete" : "failed")}`).join("; ") || "canonical"}
- Statistical comparison: ${experiment.evaluation.statisticalComparison ? JSON.stringify(experiment.evaluation.statisticalComparison) : "—"}
- Compute saved: ${((experiment.evaluation.computeSavedRatio ?? 0) * 100).toFixed(1)}%
- Experiment duration: ${formatSeconds(experiment.accounting.durationMs)} (evaluator: ${formatSeconds(experiment.accounting.evaluatorDurationMs)})
- Agent usage: ${experiment.accounting.agentUsage.requests} requests, ${experiment.accounting.agentUsage.totalTokens} tokens (${experiment.accounting.agentUsage.inputTokens} input, ${experiment.accounting.agentUsage.outputTokens} output, ${experiment.accounting.agentUsage.cacheReadTokens} cache read, ${experiment.accounting.agentUsage.cacheWriteTokens} cache write)
- Agent cost: ${formatCost(experiment.accounting.agentUsage.costUsd)}
- Cost / primary improvement: ${experiment.accounting.costPerImprovementUsd === null ? "—" : formatCost(experiment.accounting.costPerImprovementUsd)} per metric unit
- Time / primary improvement: ${formatSeconds(experiment.accounting.timePerImprovementMs)} per metric unit
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
  const paretoFrontier = state.researchGraph?.paretoFrontierIds.join(", ") || "none";
  const bestObserved = state.bestObserved;
  const bestMatchesLeader = bestObserved?.experimentId === (state.researchGraph?.leaderId ?? "baseline");
  const acceptedArtifact = "[accepted.json](accepted.json)";
  const bestArtifact = "[best-observed.json](best-observed.json)";
  const totalAgentCostUsd = state.experiments.reduce((total, experiment) => total + experiment.accounting.agentUsage.costUsd, 0);
  const totalAgentTokens = state.experiments.reduce((total, experiment) => total + experiment.accounting.agentUsage.totalTokens, 0);
  const totalExperimentDurationMs = state.experiments.reduce((total, experiment) => total + experiment.accounting.durationMs, 0);

  return `# Autoresearch run: ${state.name}

- Run ID: \`${state.runId}\`
- Status: **${state.status}**
- Started: ${state.startedAt}
- Finished: ${state.finishedAt ?? "still running"}
- Stop reason: ${state.stopReason ?? "—"}
- Agent model: \`${state.agent?.model ?? "Pi default"}\`
- Agent reasoning/thinking level: \`${state.agent?.thinkingLevel ?? "unknown"}\`
- Experiments: ${state.experiments.length} (${promoted} promoted, ${retained} retained, ${discarded} discarded, ${inconclusive} inconclusive, ${pruned} pruned, ${failed} failed)
- Active research time: ${Math.round((state.activeDurationMs ?? 0) / 1000)} seconds
- Sum of experiment durations: ${formatSeconds(totalExperimentDurationMs)}${state.experiments.length > 1 ? " (parallel experiments may overlap)" : ""}
- Total agent cost: ${formatCost(totalAgentCostUsd)}
- Total agent tokens: ${totalAgentTokens}
- Accepted workspace: \`${state.acceptedWorkspacePath}\`
- Policy leader: \`${state.researchGraph?.leaderId ?? "unknown"}\`
- Best observed result: \`${bestObserved?.experimentId ?? "unknown"}\`${bestMatchesLeader ? " (same as policy leader)" : " (not promoted by policy)"}
- Active frontier: ${frontier}
- Pareto frontier: ${paretoFrontier}

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
- Raw-best artifact: ${bestArtifact}

## Multi-objective results

${Object.entries(state.bestByObjective ?? {}).map(([name, best]) => `- ${name}: \`${best.experimentId}\` = ${best.value}`).join("\n") || "No objective winners recorded."}

- Pareto artifact: [pareto.json](pareto.json)

## Experiment graph

The chart is generated from the persisted parent graph and experiment records every time the report is written.

${renderResearchGraph(state)}

## Experiment history

| Experiment | Parent | Strategy | Category | Decision | Primary delta | Duration | Agent cost | Cost / improvement | Time / improvement | Metrics | Statistical evidence | Fresh-seed confirmation | Changed paths |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
${rows || "| — | — | — | — | — | — | — | — | — | — | — | — | — | — |"}

## Research campaign

- Queue: ${state.campaign?.tickets.filter((ticket) => ticket.status === "queued").length ?? 0} queued, ${state.campaign?.tickets.filter((ticket) => ticket.status === "running").length ?? 0} running, ${state.campaign?.tickets.filter((ticket) => ticket.status === "completed").length ?? 0} completed, ${state.campaign?.tickets.filter((ticket) => ticket.status === "blocked").length ?? 0} blocked
- Campaign artifact: [campaign.json](campaign.json)

${state.campaign?.tickets.map((ticket) => `- \`${ticket.id}\` [${ticket.kind}/${ticket.status}, priority=${ticket.priority.toFixed(3)}]: ${ticket.hypothesis}`).join("\n") || "No campaign tickets."}

## Meta-research

- Agent performance: ${state.metaResearch?.agentPerformance.map((agent) => `${agent.profileId}: trials=${agent.trials}, promotions=${agent.promotions}, failures=${agent.failures}, meanReward=${agent.meanReward.toFixed(4)}`).join("; ") || "not enabled"}
- Strategy performance: ${state.metaResearch?.strategyPerformance.filter((strategy) => strategy.trials > 0).map((strategy) => `${strategy.strategy}: trials=${strategy.trials}, meanReward=${strategy.meanReward.toFixed(4)}`).join("; ") || "no trials"}
- Policy updates: ${state.metaResearch?.policyUpdates.length ?? 0}
- Meta artifact: [meta-research.json](meta-research.json)

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
- \`experiments/*/agent-transcript.jsonl\`: timestamped, dashboard-ready thinking, messages, tool calls, results, and edit arguments without provider signatures.
- \`experiments/*/proposal.json\`: structured hypotheses, normalized categories, question IDs, and pre-registered lesson tests.
- \`experiments/*/conclusion.json\`: agent notes, question resolutions, and proposed evidence updates.
- \`experiments/*/evaluation/\`: evaluator stdout, stderr, metrics, seeds, and timings.
- \`experiments/*/proposal-review.json\`: independent reviewer decision when the reviewer role is configured.
- \`experiments/*/paired-evaluation/\`: optional candidate/reference measurements on identical fresh seeds.
- \`experiments/*/accounting.json\`: wall time, evaluator time, agent token usage/cost, and efficiency ratios.
- \`research-memory.json\` and \`RESEARCH_MEMORY.md\`: durable facts, agent notes, lesson evidence audit, and question lifecycle.
- \`frontier.json\`: parent graph, policy leader, and retained alternative checkpoints.
- \`campaign.json\`: prioritized hypothesis, search, ablation, and merge queue.
- \`pareto.json\`: Pareto frontier and per-objective winners.
- \`meta-research.json\`: agent-profile and strategy rewards plus policy updates.
- \`control.json\` and \`commands.jsonl\`: safe-boundary pause/stop state and human enqueue commands.
- \`config.resolved.json\`: immutable resolved configuration used by \`resume\`.
- \`accepted.json\`: policy-accepted leader.
- \`best-observed.json\`: lowest/highest raw primary metric observed according to metric direction.
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
