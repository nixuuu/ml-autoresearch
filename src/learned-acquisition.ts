import type { CampaignTicket, ExperimentRecord, HarnessConfig, ResearchCampaign } from "./types.js";
import { calculateCampaignPriority } from "./campaign.js";

function ticketKindForExperiment(experiment: ExperimentRecord): CampaignTicket["kind"] {
  if (experiment.strategy === "optimize") return "search";
  if (experiment.strategy === "ablate") return "ablation";
  if (experiment.strategy === "merge") return "merge";
  if (experiment.strategy === "ensemble") return "ensemble";
  return "hypothesis";
}

export function refreshLearnedCampaignPriorities(
  campaign: ResearchCampaign,
  experiments: ExperimentRecord[],
  config: HarnessConfig,
): void {
  const policy = config.learning.acquisition;
  if (!policy?.enabled) return;
  for (const ticket of campaign.tickets.filter((candidate) => candidate.status === "queued")) {
    const observations = experiments.filter((experiment) => ticketKindForExperiment(experiment) === ticket.kind && experiment.evaluation.ok);
    if (observations.length < policy.minimumObservations) continue;
    const durations = observations.map((experiment) => Math.max(1, experiment.accounting.durationMs));
    const improvements = observations.map((experiment) => experiment.accounting.primaryImprovement ?? 0);
    const positive = improvements.filter((value) => value > 0);
    const predictedDurationMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const predictedImprovement = positive.length ? positive.reduce((sum, value) => sum + value, 0) / positive.length : 0;
    const learnedProbability = positive.length / observations.length;
    const probability = Math.max(policy.explorationFloor, learnedProbability);
    const declared = calculateCampaignPriority({
      expectedGain: ticket.expectedGain,
      probability: ticket.probabilityOfSuccess,
      informationGain: ticket.informationGain,
      estimatedCost: ticket.estimatedCost,
    });
    const learned = calculateCampaignPriority({
      expectedGain: predictedImprovement,
      probability,
      informationGain: ticket.informationGain,
      estimatedCost: predictedDurationMs / 60_000,
    });
    ticket.predictedDurationMs = predictedDurationMs;
    ticket.predictedImprovement = predictedImprovement;
    ticket.learnedPriority = learned;
    ticket.priority = policy.explorationFloor * declared + (1 - policy.explorationFloor) * learned;
  }
}
