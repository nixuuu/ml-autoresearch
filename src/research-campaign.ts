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
    ...(campaign.tickets.filter((candidate) => candidate.status === "queued").length >= (config.learning.campaign?.maxQueued ?? 40)
      ? { cancellationReason: "Campaign queue capacity reached" }
      : {}),
  };
  campaign.tickets.push(ticket);
  campaign.updatedAt = now;
  return ticket;
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
