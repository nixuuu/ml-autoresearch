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
    schemaVersion: 2,
    leaderId: "baseline",
    frontierIds: [],
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

function configuredRates(config: HarnessConfig): Record<ResearchStrategy, number> {
  const strategy = config.learning.strategy;
  const nonExploit = strategy.explorationRate + strategy.backtrackRate + strategy.replicationRate + strategy.falsificationRate;
  return {
    exploit: 1 - nonExploit,
    explore: strategy.explorationRate,
    backtrack: strategy.backtrackRate,
    replicate: strategy.replicationRate,
    falsify: strategy.falsificationRate,
  };
}

function scheduledStrategy(state: RunState, config: HarnessConfig): ResearchStrategy {
  if (state.experiments.length === 0) return "exploit";
  const rates = configuredRates(config);
  const counts = Object.fromEntries(
    (["exploit", "explore", "backtrack", "replicate", "falsify"] as ResearchStrategy[])
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
  let strategy = scheduledStrategy(state, config);
  const leader = getNode(graph, graph.leaderId);
  let parent = leader;
  let reason = "Exploit the current global leader.";
  let targetLessonId: string | undefined;
  const targetQuestion = memory.questions?.find((question) => question.status === "open");

  if (strategy === "explore") {
    parent = leastUsed(graph.frontierIds
      .map((id) => getNode(graph, id))
      .filter((node) => node.branchDepth < config.learning.maxBranchDepth)) ?? leader;
    reason = parent.id === leader.id
      ? "Open a new alternative from the current leader."
      : `Develop retained alternative branch ${parent.id}.`;
  } else if (strategy === "backtrack") {
    const candidates = graph.nodes.filter((node) => node.id !== leader.id && (node.wasLeader || node.status === "frontier"));
    const selected = leastUsed(candidates);
    if (selected) {
      parent = selected;
      reason = `Backtrack to checkpoint ${parent.id} and try a different passage.`;
    } else {
      strategy = "explore";
      reason = "No older checkpoint is available; open an alternative from the leader.";
    }
  } else if (strategy === "replicate") {
    reason = `Replicate ${leader.id} without changing its workspace to test measurement stability.`;
  } else if (strategy === "falsify") {
    const lesson = supportedLesson(memory.lessons);
    if (lesson) {
      targetLessonId = lesson.id;
      reason = `Attempt to falsify ${lesson.id}: ${lesson.claim}`;
    } else {
      strategy = "explore";
      reason = "No supported lesson exists to falsify; open a new alternative from the leader.";
    }
  }

  parent.selectedCount += 1;
  const branchDepth = strategy === "replicate" ? parent.branchDepth : parent.branchDepth + 1;
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
  return selected.map((node) => node.id);
}

export function candidateFitsFrontier(
  graph: ResearchGraph,
  candidate: ResearchNode,
  config: HarnessConfig,
  primary: PrimaryMetricConfig,
): boolean {
  const existing = graph.frontierIds.map((id) => getNode(graph, id));
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
    node.status = decision.status === "retain" ? "frontier" : decision.status === "failure" ? "failed" : "discarded";
    graph.nodes.push(node);
  }

  const candidates = graph.nodes.filter((candidate) =>
    candidate.id !== graph.leaderId
    && (candidate.status === "frontier" || candidate.wasLeader));
  const frontierIds = selectFrontierIds(graph, candidates, config, primary);
  graph.frontierIds = frontierIds;
  for (const candidate of candidates) {
    candidate.status = frontierIds.includes(candidate.id) ? "frontier" : "retired";
  }
}
