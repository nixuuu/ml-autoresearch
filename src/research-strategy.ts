import type {
  DecisionResult,
  HarnessConfig,
  PrimaryMetricConfig,
  ResearchAssignment,
  ResearchGraph,
  ResearchLesson,
  ResearchNode,
  ResearchStrategy,
  RunState,
} from "./types.js";
import { normalizeChangeCategory } from "./change-category.js";
import { configuredObjectives, paretoFrontier } from "./pareto.js";
import { claimCampaignTicket } from "./research-campaign.js";

export function primaryImprovement(
  reference: Record<string, number>,
  candidate: Record<string, number>,
  primary: PrimaryMetricConfig,
): number {
  const referenceValue = reference[primary.name];
  const candidateValue = candidate[primary.name];
  if (referenceValue === undefined || candidateValue === undefined) return Number.NEGATIVE_INFINITY;
  return primary.direction === "maximize" ? candidateValue - referenceValue : referenceValue - candidateValue;
}

export function temporaryRegressionRatio(
  leader: Record<string, number>,
  candidate: Record<string, number>,
  primary: PrimaryMetricConfig,
): number {
  const delta = primaryImprovement(leader, candidate, primary);
  if (delta >= 0) return 0;
  const leaderValue = Math.abs(leader[primary.name] ?? 0);
  return -delta / Math.max(leaderValue, 1e-12);
}

export function createResearchGraph(
  workspacePath: string,
  workspaceFingerprint: string,
  metrics: Record<string, number>,
): ResearchGraph {
  return {
    schemaVersion: 3,
    leaderId: "baseline",
    frontierIds: [],
    paretoFrontierIds: ["baseline"],
    nodes: [{
      id: "baseline",
      workspacePath,
      workspaceFingerprint,
      metrics,
      branchDepth: 0,
      status: "leader",
      wasLeader: true,
      strategy: "exploit",
      changeCategory: "baseline",
      selectedCount: 0,
    }],
  };
}

function getNode(graph: ResearchGraph, id: string): ResearchNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Research graph node does not exist: ${id}`);
  return node;
}

function supportedLesson(lessons: ResearchLesson[]): ResearchLesson | undefined {
  return lessons
    .filter((lesson) => lesson.status === "supported" || lesson.status === "human-approved")
    .sort((left, right) => left.evidenceAgainst.length - right.evidenceAgainst.length || left.updatedAt.localeCompare(right.updatedAt))[0];
}

function configuredRates(state: RunState, config: HarnessConfig): Record<ResearchStrategy, number> {
  const strategy = config.learning.strategy;
  const nonExploit = strategy.explorationRate + strategy.backtrackRate + strategy.replicationRate + strategy.falsificationRate
    + (strategy.optimizeRate ?? 0) + (strategy.mergeRate ?? 0) + (strategy.ablationRate ?? 0);
  const configured: Record<ResearchStrategy, number> = {
    exploit: 1 - nonExploit,
    explore: strategy.explorationRate,
    backtrack: strategy.backtrackRate,
    replicate: strategy.replicationRate,
    falsify: strategy.falsificationRate,
    optimize: strategy.optimizeRate ?? 0,
    merge: strategy.mergeRate ?? 0,
    ablate: strategy.ablationRate ?? 0,
  };
  const metaRates = state.metaResearch?.policyUpdates.at(-1)?.strategyRates;
  if (metaRates) {
    for (const [name, rate] of Object.entries(metaRates) as Array<[ResearchStrategy, number | undefined]>) {
      if (rate !== undefined) configured[name] = rate;
    }
    const total = Object.values(configured).reduce((sum, rate) => sum + Math.max(0, rate), 0);
    if (total > 0) for (const name of Object.keys(configured) as ResearchStrategy[]) configured[name] = Math.max(0, configured[name]) / total;
  }
  if (!config.search?.enabled || config.search.parameters.length === 0) configured.optimize = 0;
  if (!state.campaign?.tickets.some((ticket) => ticket.status === "queued" && ticket.kind === "merge")) configured.merge = 0;
  if (!state.campaign?.tickets.some((ticket) => ticket.status === "queued" && ticket.kind === "ablation")) configured.ablate = 0;
  return configured;
}

function scheduledStrategy(state: RunState, config: HarnessConfig): ResearchStrategy {
  if (state.experiments.length === 0) return "exploit";
  const rates = configuredRates(state, config);
  const counts = Object.fromEntries(
    (["exploit", "explore", "backtrack", "replicate", "falsify", "optimize", "merge", "ablate"] as ResearchStrategy[])
      .map((strategy) => [strategy, state.experiments.filter((experiment) => experiment.strategy === strategy).length]),
  ) as Record<ResearchStrategy, number>;
  const nextTotal = state.experiments.length + 1;
  return (Object.keys(rates) as ResearchStrategy[])
    .sort((left, right) => (rates[right] * nextTotal - counts[right]) - (rates[left] * nextTotal - counts[left]))[0]!;
}

function leastUsed(nodes: ResearchNode[]): ResearchNode | undefined {
  return [...nodes].sort((left, right) => left.selectedCount - right.selectedCount || left.id.localeCompare(right.id))[0];
}

export function chooseResearchAssignment(state: RunState, config: HarnessConfig): ResearchAssignment {
  const graph = state.researchGraph;
  const memory = state.researchMemory;
  if (!graph || !memory) throw new Error("Research learning state is missing");
  const campaignPolicy = config.learning.campaign;
  const queuedCount = state.campaign?.tickets.filter((ticket) => ticket.status === "queued").length ?? 0;
  const campaignTarget = campaignPolicy?.enabled
    ? Math.ceil((state.experiments.length + 1) * campaignPolicy.queueRate)
    : 0;
  const campaignCompleted = state.experiments.filter((experiment) => experiment.ticketId).length;
  const ticket = queuedCount > 0 && campaignCompleted < campaignTarget && state.campaign
    ? claimCampaignTicket(state.campaign, `assignment-${state.experiments.length + 1}`)
    : undefined;
  let strategy: ResearchStrategy = ticket
    ? ticket.kind === "ablation" ? "ablate" : ticket.kind === "merge" ? "merge" : ticket.kind === "search" ? "optimize" : "explore"
    : scheduledStrategy(state, config);
  const leader = getNode(graph, graph.leaderId);
  let parent = leader;
  let reason = "Exploit the current global leader.";
  let targetLessonId: string | undefined;
  const targetQuestion = memory.questions?.find((question) => question.status === "open");

  if (ticket?.ablation) {
    parent = getNode(graph, ticket.ablation.sourceExperimentId);
    reason = `Run planned ablation ${ticket.id}: ${ticket.hypothesis}`;
  } else if (ticket?.merge) {
    parent = getNode(graph, ticket.merge.sourceExperimentIds[0]);
    reason = `Merge independent checkpoints ${ticket.merge.sourceExperimentIds.join(" + ")}: ${ticket.hypothesis}`;
  } else if (ticket?.kind === "search") {
    reason = `Evaluate planned parameter search ticket ${ticket.id}: ${ticket.hypothesis}`;
  } else if (ticket) {
    reason = `Address campaign ticket ${ticket.id}: ${ticket.hypothesis}`;
  }

  if (!ticket && strategy === "explore") {
    parent = leastUsed(graph.frontierIds
      .map((id) => getNode(graph, id))
      .filter((node) => node.branchDepth < config.learning.maxBranchDepth)) ?? leader;
    reason = parent.id === leader.id
      ? "Open a new alternative from the current leader."
      : `Develop retained alternative branch ${parent.id}.`;
  } else if (!ticket && strategy === "backtrack") {
    const candidates = graph.nodes.filter((node) => node.id !== leader.id && (node.wasLeader || node.status === "frontier"));
    const selected = leastUsed(candidates);
    if (selected) {
      parent = selected;
      reason = `Backtrack to checkpoint ${parent.id} and try a different passage.`;
    } else {
      strategy = "explore";
      reason = "No older checkpoint is available; open an alternative from the leader.";
    }
  } else if (!ticket && strategy === "replicate") {
    reason = `Replicate ${leader.id} without changing its workspace to test measurement stability.`;
  } else if (!ticket && strategy === "falsify") {
    const lesson = supportedLesson(memory.lessons);
    if (lesson) {
      targetLessonId = lesson.id;
      reason = `Attempt to falsify ${lesson.id}: ${lesson.claim}`;
    } else {
      strategy = "explore";
      reason = "No supported lesson exists to falsify; open a new alternative from the leader.";
    }
  } else if (!ticket && strategy === "optimize") {
    reason = "Run a deterministic hybrid-search suggestion around the current parameter leader.";
  } else if (!ticket && (strategy === "merge" || strategy === "ablate")) {
    const unavailable = strategy;
    strategy = "explore";
    reason = `No queued ${unavailable} ticket is ready; open a new alternative from the leader.`;
  }

  parent.selectedCount += 1;
  const mergeSource = strategy === "merge" && ticket?.merge
    ? getNode(graph, ticket.merge.sourceExperimentIds[1])
    : undefined;
  const branchDepth = strategy === "replicate"
    ? parent.branchDepth
    : mergeSource
      ? Math.max(parent.branchDepth, mergeSource.branchDepth) + 1
      : parent.branchDepth + 1;
  if (targetQuestion && strategy !== "replicate" && strategy !== "falsify") {
    reason += ` Address ${targetQuestion.id}: ${targetQuestion.text}`;
  }
  return {
    strategy,
    parentId: parent.id,
    parentWorkspacePath: parent.workspacePath,
    parentMetrics: parent.metrics,
    branchDepth,
    reason,
    ...(targetLessonId ? { targetLessonId } : {}),
    ...(targetQuestion && strategy !== "replicate" && strategy !== "falsify" ? { targetQuestionId: targetQuestion.id } : {}),
    ...(ticket ? { ticketId: ticket.id, plannedHypothesis: ticket.hypothesis } : {}),
    ...(ticket?.ablation ? { ablation: ticket.ablation } : {}),
    ...(ticket?.merge ? { merge: ticket.merge } : {}),
    ...(ticket?.searchSuggestion ? { searchSuggestion: ticket.searchSuggestion } : {}),
  };
}

function selectFrontierIds(
  graph: ResearchGraph,
  candidates: ResearchNode[],
  config: HarnessConfig,
  primary: PrimaryMetricConfig,
): string[] {
  const leader = getNode(graph, graph.leaderId);
  const eligible = candidates
    .filter((node) => node.id !== leader.id)
    .filter((node) => node.branchDepth <= config.learning.maxBranchDepth)
    .filter((node) => temporaryRegressionRatio(leader.metrics, node.metrics, primary) <= config.learning.maxTemporaryRegressionRatio)
    .sort((left, right) => {
      const score = primaryImprovement(leader.metrics, right.metrics, primary) - primaryImprovement(leader.metrics, left.metrics, primary);
      return score || left.selectedCount - right.selectedCount || left.id.localeCompare(right.id);
    });

  const selected: ResearchNode[] = [];
  const categoryCounts = new Map<string, number>();
  for (const node of eligible) {
    if (selected.length >= config.learning.beamWidth) break;
    const category = node.changeCategory === "baseline" ? "baseline" : normalizeChangeCategory(node.changeCategory);
    const categoryCount = categoryCounts.get(category) ?? 0;
    if (categoryCount < (config.learning.maxFrontierPerCategory ?? 1)) {
      selected.push(node);
      categoryCounts.set(category, categoryCount + 1);
    }
  }
  if (config.metrics.pareto?.enabled) {
    const pool = new Map(graph.nodes
      .filter((node) => node.status !== "failed" && node.status !== "discarded")
      .map((node) => [node.id, node]));
    for (const candidate of candidates) pool.set(candidate.id, candidate);
    const paretoIds = new Set(paretoFrontier([...pool.values()], configuredObjectives(config)).map((node) => node.id));
    for (const node of eligible
      .filter((candidate) => paretoIds.has(candidate.id) && !selected.some((entry) => entry.id === candidate.id))
      .sort((left, right) => left.id.localeCompare(right.id))) {
      // Pareto candidates are an explicit, bounded extension of the primary
      // beam: at most one entry per Pareto checkpoint, never beyond depth or
      // temporary-regression limits already enforced by `eligible`.
      selected.push(node);
    }
  }
  return selected.map((node) => node.id);
}

export function candidateFitsFrontier(
  graph: ResearchGraph,
  candidate: ResearchNode,
  config: HarnessConfig,
  primary: PrimaryMetricConfig,
): boolean {
  const ids = [...new Set([...graph.frontierIds, ...(graph.paretoFrontierIds ?? [])])];
  const existing = ids.map((id) => getNode(graph, id));
  return selectFrontierIds(graph, [...existing, candidate], config, primary).includes(candidate.id);
}

export function applyGraphDecision(
  graph: ResearchGraph,
  node: ResearchNode,
  decision: DecisionResult,
  config: HarnessConfig,
  primary: PrimaryMetricConfig,
): void {
  if (node.strategy === "replicate" && node.workspaceFingerprint === getNode(graph, node.parentId!).workspaceFingerprint) return;

  if (decision.status === "promote") {
    const oldLeader = getNode(graph, graph.leaderId);
    oldLeader.status = "retired";
    node.status = "leader";
    node.wasLeader = true;
    node.branchDepth = 0;
    graph.nodes.push(node);
    graph.leaderId = node.id;
  } else {
    node.status = decision.status === "retain" || decision.status === "inconclusive" ? "frontier" : decision.status === "failure" ? "failed" : "discarded";
    graph.nodes.push(node);
  }

  const candidates = graph.nodes.filter((candidate) =>
    candidate.id !== graph.leaderId
    && (candidate.status === "frontier" || candidate.wasLeader || graph.paretoFrontierIds.includes(candidate.id)));
  const frontierIds = selectFrontierIds(graph, candidates, config, primary);
  graph.frontierIds = frontierIds;
  for (const candidate of candidates) {
    candidate.status = frontierIds.includes(candidate.id) ? "frontier" : "retired";
  }
  const objectives = configuredObjectives(config);
  const pareto = config.metrics.pareto?.enabled
    ? paretoFrontier(graph.nodes.filter((candidate) => candidate.status !== "failed" && candidate.status !== "discarded"), objectives)
    : [getNode(graph, graph.leaderId)];
  graph.paretoFrontierIds = pareto.map((candidate) => candidate.id);
  for (const candidate of graph.nodes) candidate.paretoOptimal = graph.paretoFrontierIds.includes(candidate.id);
}
