import type {
  CampaignTicket,
  ExperimentRecord,
  HarnessConfig,
  ResearchCampaign,
  ResearchGraph,
} from "./types.js";
import { calculateCampaignPriority } from "./campaign.js";
import { normalizeClaim } from "./research-memory.js";

export interface EnqueueTicketInput {
  kind: CampaignTicket["kind"];
  hypothesis: string;
  createdBy: CampaignTicket["createdBy"];
  dependencies?: string[];
  expectedGain?: number;
  probabilityOfSuccess?: number;
  informationGain?: number;
  estimatedCost?: number;
  ablation?: CampaignTicket["ablation"];
  merge?: CampaignTicket["merge"];
  searchSuggestion?: CampaignTicket["searchSuggestion"];
  ensemble?: CampaignTicket["ensemble"];
}

export function createResearchCampaign(goal: string, runId: string, now = new Date().toISOString()): ResearchCampaign {
  return { schemaVersion: 1, id: `campaign-${runId}`, goal, createdAt: now, updatedAt: now, tickets: [] };
}

function nextTicketId(campaign: ResearchCampaign): string {
  const next = campaign.tickets.reduce((maximum, ticket) => {
    const match = ticket.id.match(/ticket-(\d+)$/);
    return Math.max(maximum, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `ticket-${String(next).padStart(4, "0")}`;
}

export function enqueueCampaignTicket(
  campaign: ResearchCampaign,
  input: EnqueueTicketInput,
  config: HarnessConfig,
  now = new Date().toISOString(),
): CampaignTicket {
  const normalized = normalizeClaim(input.hypothesis);
  const existing = campaign.tickets.find((ticket) => normalizeClaim(ticket.hypothesis) === normalized && ticket.kind === input.kind);
  if (existing) return existing;
  const expectedGain = input.expectedGain ?? 0;
  const probabilityOfSuccess = input.probabilityOfSuccess ?? 0.5;
  const informationGain = input.informationGain ?? 0.5;
  const estimatedCost = input.estimatedCost ?? 1;
  const ticket: CampaignTicket = {
    id: nextTicketId(campaign),
    kind: input.kind,
    hypothesis: input.hypothesis.trim(),
    status: campaign.tickets.filter((candidate) => candidate.status === "queued").length >= (config.learning.campaign?.maxQueued ?? 40) ? "cancelled" : "queued",
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
    dependencies: [...new Set(input.dependencies ?? [])],
    expectedGain,
    probabilityOfSuccess,
    informationGain,
    estimatedCost,
    priority: calculateCampaignPriority({ expectedGain, probability: probabilityOfSuccess, informationGain, estimatedCost }),
    ...(input.ablation ? { ablation: input.ablation } : {}),
    ...(input.merge ? { merge: input.merge } : {}),
    ...(input.searchSuggestion ? { searchSuggestion: input.searchSuggestion } : {}),
    ...(input.ensemble ? { ensemble: input.ensemble } : {}),
    ...(campaign.tickets.filter((candidate) => candidate.status === "queued").length >= (config.learning.campaign?.maxQueued ?? 40)
      ? { cancellationReason: "Campaign queue capacity reached" }
      : {}),
  };
  campaign.tickets.push(ticket);
  campaign.updatedAt = now;
  return ticket;
}

export function enqueueEnsembleCandidate(
  campaign: ResearchCampaign,
  graph: ResearchGraph,
  experiments: ExperimentRecord[],
  config: HarnessConfig,
): CampaignTicket | undefined {
  const policy = config.learning.ensemble;
  if (!policy?.enabled || experiments.length === 0 || experiments.length % policy.interval !== 0) return undefined;
  const candidateIds = [...new Set([graph.leaderId, ...graph.paretoFrontierIds, ...graph.frontierIds])]
    .filter((id) => id !== "baseline")
    .filter((id) => experiments.some((experiment) => experiment.id === id && experiment.evaluation.ok && !experiment.evaluation.pruned))
    .slice(0, policy.maximumMembers);
  if (candidateIds.length < policy.minimumMembers) return undefined;
  return enqueueCampaignTicket(campaign, {
    kind: "ensemble",
    hypothesis: `Build and evaluate a controlled ensemble of distinct retained checkpoints ${candidateIds.join(", ")}; combine their complementary errors without changing the evaluation protocol.`,
    createdBy: "harness",
    probabilityOfSuccess: 0.45,
    informationGain: 0.9,
    estimatedCost: 1.5,
    ensemble: { sourceExperimentIds: candidateIds },
  }, config);
}

function sliceObservations(experiment: ExperimentRecord): Array<{ name: string; count: number; metrics: Record<string, number> }> {
  const payloads = experiment.evaluation.attempts.flatMap((attempt) => {
    const value = attempt.metadata?.sliceMetrics;
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).map(([name, metrics]) => ({ name, count: 0, metrics }));
    }
    return [];
  });
  const observations = payloads.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.count !== "number" || !record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) return [];
    const metrics = Object.fromEntries(Object.entries(record.metrics as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
    return Object.keys(metrics).length ? [{ name: record.name, count: record.count, metrics }] : [];
  });
  const names = [...new Set(observations.map((observation) => observation.name))];
  return names.map((name) => {
    const matching = observations.filter((observation) => observation.name === name);
    const metricNames = [...new Set(matching.flatMap((observation) => Object.keys(observation.metrics)))];
    return {
      name,
      // Attempts usually evaluate the same slice population. The minimum is
      // conservative and avoids multiplying sample depth by repetitions.
      count: Math.min(...matching.map((observation) => observation.count)),
      metrics: Object.fromEntries(metricNames.flatMap((metricName) => {
        const values = matching.flatMap((observation) => observation.metrics[metricName] === undefined ? [] : [observation.metrics[metricName]!]);
        return values.length ? [[metricName, values.reduce((sum, value) => sum + value, 0) / values.length]] : [];
      })),
    };
  });
}

export function enqueueSliceDiscoveries(
  campaign: ResearchCampaign,
  experiment: ExperimentRecord,
  config: HarnessConfig,
): CampaignTicket[] {
  const policy = config.learning.sliceDiscovery;
  if (!policy?.enabled || !experiment.evaluation.ok) return [];
  const metric = config.metrics.primary;
  const observations = sliceObservations(experiment)
    .filter((slice) => slice.count >= policy.minimumSamples && slice.metrics[metric.name] !== undefined)
    .map((slice) => ({
      ...slice,
      gap: metric.direction === "maximize"
        ? experiment.evaluation.aggregatedMetrics[metric.name]! - slice.metrics[metric.name]!
        : slice.metrics[metric.name]! - experiment.evaluation.aggregatedMetrics[metric.name]!,
    }))
    .filter((slice) => slice.gap >= policy.regressionThreshold)
    .sort((left, right) => right.gap - left.gap)
    .slice(0, policy.maximumTickets);
  return observations.map((slice) => enqueueCampaignTicket(campaign, {
    kind: "slice",
    hypothesis: `Improve weak slice ${slice.name} (${slice.count} samples, ${metric.name}=${slice.metrics[metric.name]}) without regressing the global primary metric or guardrails.`,
    createdBy: "harness",
    expectedGain: slice.gap,
    probabilityOfSuccess: 0.35,
    informationGain: 1,
    estimatedCost: 1,
  }, config));
}

export function claimCampaignTicket(campaign: ResearchCampaign, experimentId: string): CampaignTicket | undefined {
  for (const ticket of campaign.tickets.filter((candidate) => candidate.status === "queued")) {
    const blocked = ticket.dependencies.some((dependency) => {
      const prerequisite = campaign.tickets.find((candidate) => candidate.id === dependency);
      return !prerequisite || prerequisite.status === "cancelled" || prerequisite.status === "blocked";
    });
    if (blocked) {
      ticket.status = "blocked";
      ticket.cancellationReason = "A prerequisite ticket is missing, cancelled, or blocked";
      ticket.updatedAt = new Date().toISOString();
    }
  }
  const ready = campaign.tickets
    .filter((ticket) => ticket.status === "queued" && ticket.dependencies.every((dependency) => campaign.tickets.find((candidate) => candidate.id === dependency)?.status === "completed"))
    .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  if (!ready) return undefined;
  ready.status = "running";
  ready.claimedBy = experimentId;
  ready.updatedAt = new Date().toISOString();
  campaign.updatedAt = ready.updatedAt;
  return ready;
}

function hypothesisTokens(value: string): Set<string> {
  return new Set(normalizeClaim(value).split(" ").filter((token) => token.length >= 3));
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = hypothesisTokens(left);
  const rightTokens = hypothesisTokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / union.size;
}

/** Reconcile work selected outside the queue with the most similar queued ticket. */
export function claimRelatedCampaignTicket(
  campaign: ResearchCampaign,
  experimentId: string,
  hypothesis: string,
  threshold: number,
): CampaignTicket | undefined {
  const candidate = campaign.tickets
    .filter((ticket) => ticket.status === "queued" && ticket.dependencies.every((dependency) =>
      campaign.tickets.find((entry) => entry.id === dependency)?.status === "completed"))
    .map((ticket) => ({ ticket, similarity: tokenSimilarity(hypothesis, ticket.hypothesis) }))
    .filter((entry) => entry.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity || right.ticket.priority - left.ticket.priority)[0];
  if (!candidate) return undefined;
  const now = new Date().toISOString();
  candidate.ticket.status = "running";
  candidate.ticket.claimedBy = experimentId;
  candidate.ticket.updatedAt = now;
  campaign.updatedAt = now;
  return candidate.ticket;
}

export function finishCampaignTicket(campaign: ResearchCampaign, ticketId: string | undefined, experiment: ExperimentRecord): void {
  if (!ticketId) return;
  const ticket = campaign.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) return;
  ticket.status = experiment.decision.status === "failure" ? "cancelled" : "completed";
  ticket.resultExperimentId = experiment.id;
  ticket.updatedAt = experiment.finishedAt;
  if (experiment.decision.status === "failure") ticket.cancellationReason = experiment.decision.reasons.join("; ");
  campaign.updatedAt = experiment.finishedAt;
}

export function enqueueConclusionHypotheses(
  campaign: ResearchCampaign,
  experiment: ExperimentRecord,
  config: HarnessConfig,
): CampaignTicket[] {
  return (experiment.conclusion?.nextHypotheses ?? []).slice(0, config.learning.campaign?.hypothesesPerProposal ?? 4).map((hypothesis) =>
    enqueueCampaignTicket(campaign, {
      kind: "hypothesis",
      hypothesis,
      createdBy: "agent",
      dependencies: [experiment.ticketId].filter((value): value is string => Boolean(value)),
      ...(experiment.plan?.expectedGain === undefined ? {} : { expectedGain: experiment.plan.expectedGain }),
      ...(experiment.plan?.probabilityOfSuccess === undefined ? {} : { probabilityOfSuccess: experiment.plan.probabilityOfSuccess }),
      ...(experiment.plan?.informationGain === undefined ? {} : { informationGain: experiment.plan.informationGain }),
      ...(experiment.plan?.estimatedCost === undefined ? {} : { estimatedCost: experiment.plan.estimatedCost }),
    }, config));
}

export function enqueuePromotionAblations(
  campaign: ResearchCampaign,
  experiment: ExperimentRecord,
  config: HarnessConfig,
): CampaignTicket[] {
  if (!config.learning.campaign?.autoAblations || experiment.decision.status !== "promote" || experiment.changedPaths.length < 2) return [];
  return experiment.changedPaths.slice(0, config.learning.campaign.maxAblationsPerPromotion).map((removePath) =>
    enqueueCampaignTicket(campaign, {
      kind: "ablation",
      hypothesis: `Removing ${removePath} from ${experiment.id} will reveal whether that component is necessary for the promoted improvement.`,
      createdBy: "harness",
      informationGain: 1,
      probabilityOfSuccess: 0.5,
      estimatedCost: 1,
      ablation: { sourceExperimentId: experiment.id, removePath },
    }, config));
}

export function enqueueMergeCandidate(
  campaign: ResearchCampaign,
  graph: ResearchGraph,
  experiments: ExperimentRecord[],
  config: HarnessConfig,
): CampaignTicket | undefined {
  if (!config.learning.campaign?.autoMerge || graph.frontierIds.length < 2) return undefined;
  const parentOf = (id: string): string | undefined => graph.nodes.find((node) => node.id === id)?.parentId;
  const ancestry = (id: string): string[] => {
    const result: string[] = [];
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      result.push(current);
      visited.add(current);
      current = parentOf(current);
    }
    return result;
  };
  const lowestCommonAncestor = (leftId: string, rightId: string): string | undefined => {
    const leftAncestors = new Set(ancestry(leftId));
    return ancestry(rightId).find((id) => leftAncestors.has(id));
  };
  const changedPathsSince = (sourceId: string, ancestorId: string): string[] | undefined => {
    const changedPaths = new Set<string>();
    const visited = new Set<string>();
    let current: string | undefined = sourceId;
    while (current && current !== ancestorId && !visited.has(current)) {
      const experiment = experiments.find((candidate) => candidate.id === current);
      if (!experiment) return undefined;
      for (const changedPath of experiment.changedPaths) changedPaths.add(changedPath);
      visited.add(current);
      current = parentOf(current);
    }
    return current === ancestorId ? [...changedPaths].sort() : undefined;
  };
  for (let leftIndex = 0; leftIndex < graph.frontierIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < graph.frontierIds.length; rightIndex += 1) {
      const leftId = graph.frontierIds[leftIndex]!;
      const rightId = graph.frontierIds[rightIndex]!;
      const left = experiments.find((experiment) => experiment.id === leftId);
      const right = experiments.find((experiment) => experiment.id === rightId);
      if (!left || !right) continue;
      const commonAncestor = lowestCommonAncestor(leftId, rightId);
      if (!commonAncestor || commonAncestor === leftId || commonAncestor === rightId) continue;
      const leftPaths = changedPathsSince(leftId, commonAncestor);
      const rightPaths = changedPathsSince(rightId, commonAncestor);
      if (!leftPaths || !rightPaths || leftPaths.length === 0 || rightPaths.length === 0) continue;
      const overlap = leftPaths.some((changedPath) => rightPaths.includes(changedPath));
      if (overlap) continue;
      return enqueueCampaignTicket(campaign, {
        kind: "merge",
        hypothesis: `Combine independent changes from ${leftId} and ${rightId}; their disjoint mechanisms may be additive.`,
        createdBy: "harness",
        expectedGain: Math.max(left.decision.primaryDelta ?? 0, 0) + Math.max(right.decision.primaryDelta ?? 0, 0),
        probabilityOfSuccess: 0.4,
        informationGain: 0.8,
        estimatedCost: 1.2,
        merge: { sourceExperimentIds: [leftId, rightId], pathsFromSecond: rightPaths },
      }, config);
    }
  }
  return undefined;
}
