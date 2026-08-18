import type { EvaluationAttempt, EvaluationResult, EvaluationSemanticSummary, RunState } from "./types.js";

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))].sort();
}

function metadataValue(metadata: Record<string, unknown> | undefined, snake: string, camel: string): unknown {
  return metadata?.[snake] ?? metadata?.[camel];
}

export function allEvaluationAttempts(evaluation: EvaluationResult): EvaluationAttempt[] {
  const staged = evaluation.stages?.flatMap((stage) => stage.attempts) ?? [];
  const attempts = staged.length > 0 ? staged : evaluation.attempts;
  const unique = new Map<string, EvaluationAttempt>();
  for (const attempt of attempts) unique.set(`${attempt.stage ?? "canonical"}:${attempt.seed}:${attempt.repetition}`, attempt);
  return [...unique.values()];
}

export function summarizeEvaluationSemantics(evaluation: Pick<EvaluationResult, "attempts" | "stages">): EvaluationSemanticSummary | undefined {
  const attempts = evaluation.stages?.flatMap((stage) => stage.attempts) ?? evaluation.attempts;
  const predictionHashes: Record<string, string> = {};
  const capabilities = new Set<string>();
  const consumed = new Set<string>();
  let reportedCandidateCapabilities = false;
  let reportedConsumedSearchParameters = false;
  for (const attempt of attempts) {
    const metadata = attempt.metadata;
    const hash = metadataValue(metadata, "prediction_sha256", "predictionSha256");
    if (typeof hash === "string" && hash.trim()) predictionHashes[`${attempt.stage ?? "canonical"}:${attempt.seed}`] = hash.trim();
    const capabilityValue = metadataValue(metadata, "candidate_capabilities", "candidateCapabilities");
    const consumedValue = metadataValue(metadata, "consumed_search_parameters", "consumedSearchParameters");
    if (capabilityValue !== undefined) reportedCandidateCapabilities = true;
    if (consumedValue !== undefined) reportedConsumedSearchParameters = true;
    for (const capability of strings(capabilityValue)) capabilities.add(capability);
    for (const parameter of strings(consumedValue)) consumed.add(parameter);
  }
  if (Object.keys(predictionHashes).length === 0 && capabilities.size === 0 && consumed.size === 0
    && !reportedCandidateCapabilities && !reportedConsumedSearchParameters) return undefined;
  return {
    predictionHashes,
    candidateCapabilities: [...capabilities].sort(),
    consumedSearchParameters: [...consumed].sort(),
    reportedCandidateCapabilities,
    reportedConsumedSearchParameters,
  };
}

export function predictionEquivalent(
  candidateAttempts: EvaluationAttempt[],
  reference: EvaluationResult,
): boolean {
  if (candidateAttempts.length === 0) return false;
  const referenceHashes = summarizeEvaluationSemantics(reference)?.predictionHashes ?? {};
  let compared = 0;
  for (const attempt of candidateAttempts) {
    const hash = metadataValue(attempt.metadata, "prediction_sha256", "predictionSha256");
    if (typeof hash !== "string" || !hash.trim()) return false;
    const key = `${attempt.stage ?? "canonical"}:${attempt.seed}`;
    const referenceHash = referenceHashes[key];
    if (!referenceHash || referenceHash !== hash.trim()) return false;
    compared += 1;
  }
  return compared > 0;
}

export function checkpointEvaluation(state: RunState, checkpointId: string): EvaluationResult | undefined {
  if (checkpointId === "baseline") return state.baseline;
  return state.experiments.find((experiment) => experiment.id === checkpointId)?.evaluation;
}

export function checkpointCapabilities(state: RunState, checkpointId: string): Set<string> {
  return new Set(checkpointEvaluation(state, checkpointId)?.semantic?.candidateCapabilities
    ?? (checkpointEvaluation(state, checkpointId) ? summarizeEvaluationSemantics(checkpointEvaluation(state, checkpointId)!)?.candidateCapabilities : [])
    ?? []);
}

export function evaluationConsumedParameters(evaluation: EvaluationResult): Set<string> {
  return new Set(evaluation.semantic?.consumedSearchParameters
    ?? summarizeEvaluationSemantics(evaluation)?.consumedSearchParameters
    ?? []);
}
