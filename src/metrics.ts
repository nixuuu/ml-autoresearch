import type {
  Aggregation,
  DecisionResult,
  EvaluationResult,
  GuardrailMetricConfig,
  PrimaryMetricConfig,
} from "./types.js";

export function aggregate(values: number[], method: Aggregation): number {
  if (values.length === 0) throw new Error("Cannot aggregate an empty metric series");
  const sorted = [...values].sort((a, b) => a - b);
  switch (method) {
    case "mean": return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "median": {
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    }
    case "min": return sorted[0]!;
    case "max": return sorted.at(-1)!;
  }
}

export function aggregateAttempts(
  metricNames: Array<{ name: string; aggregation: Aggregation }>,
  attempts: Array<{ metrics?: Record<string, number> }>,
): Record<string, number> {
  return Object.fromEntries(metricNames.map((metric) => {
    const values = attempts.map((attempt) => attempt.metrics?.[metric.name]);
    if (values.some((value) => value === undefined || !Number.isFinite(value))) {
      throw new Error(`Metric ${metric.name} is missing or non-finite in at least one repetition`);
    }
    return [metric.name, aggregate(values as number[], metric.aggregation)];
  }));
}

function improvement(accepted: number, candidate: number, direction: PrimaryMetricConfig["direction"]): number {
  return direction === "maximize" ? candidate - accepted : accepted - candidate;
}

export function decideCandidate(
  acceptedMetrics: Record<string, number>,
  candidate: EvaluationResult,
  primary: PrimaryMetricConfig,
  guardrails: GuardrailMetricConfig[],
): DecisionResult {
  if (!candidate.ok) return { status: "failure", primaryDelta: null, reasons: [candidate.error ?? "Evaluation failed"] };
  const acceptedPrimary = acceptedMetrics[primary.name];
  const candidatePrimary = candidate.aggregatedMetrics[primary.name];
  if (acceptedPrimary === undefined || candidatePrimary === undefined) {
    return { status: "failure", primaryDelta: null, reasons: [`Primary metric ${primary.name} is missing`] };
  }

  const delta = improvement(acceptedPrimary, candidatePrimary, primary.direction);
  const reasons: string[] = [];
  if (delta < primary.minimumDelta) {
    reasons.push(`Primary improvement ${delta.toPrecision(6)} is below required ${primary.minimumDelta}`);
  } else {
    reasons.push(`Primary improvement ${delta.toPrecision(6)} meets required ${primary.minimumDelta}`);
  }

  for (const rule of guardrails) {
    const accepted = acceptedMetrics[rule.name];
    const value = candidate.aggregatedMetrics[rule.name];
    if (accepted === undefined || value === undefined) {
      reasons.push(`Guardrail metric ${rule.name} is missing`);
      continue;
    }
    if (rule.min !== undefined && value < rule.min) reasons.push(`${rule.name}=${value} is below minimum ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) reasons.push(`${rule.name}=${value} is above maximum ${rule.max}`);
    if (rule.maxRegression !== undefined) {
      const regression = rule.direction === "maximize" ? accepted - value : value - accepted;
      if (regression > rule.maxRegression) reasons.push(`${rule.name} regressed by ${regression}, over limit ${rule.maxRegression}`);
    }
  }

  const failed = delta < primary.minimumDelta || reasons.some((reason) => reason.includes("missing") || reason.includes("below minimum") || reason.includes("above maximum") || reason.includes("over limit"));
  return { status: failed ? "reject" : "keep", primaryDelta: delta, reasons };
}

export function decideResearchCandidate(
  leaderMetrics: Record<string, number>,
  candidate: EvaluationResult,
  primary: PrimaryMetricConfig,
  guardrails: GuardrailMetricConfig[],
  branchDepth: number,
  maxBranchDepth: number,
  maxTemporaryRegressionRatio: number,
  paretoOptimal = false,
): DecisionResult {
  if (!candidate.ok) return { status: "failure", primaryDelta: null, reasons: [candidate.error ?? "Evaluation failed"] };
  const leaderPrimary = leaderMetrics[primary.name];
  const candidatePrimary = candidate.aggregatedMetrics[primary.name];
  if (leaderPrimary === undefined || candidatePrimary === undefined) {
    return { status: "failure", primaryDelta: null, reasons: [`Primary metric ${primary.name} is missing`] };
  }

  const delta = improvement(leaderPrimary, candidatePrimary, primary.direction);
  const reasons: string[] = [];
  const statisticalStatus = candidate.statisticalComparison?.status;
  if (candidate.pruned) {
    return {
      status: "pruned",
      primaryDelta: delta,
      reasons: [candidate.statisticalComparison?.confidenceAvailable
        ? "Candidate was pruned by an intermediate evaluation stage after a statistically clear regression"
        : "Candidate was pruned by an intermediate screening stage after a clear deterministic regression outside the equivalence margin"],
      ...(statisticalStatus ? { statisticalStatus } : {}),
      paretoOptimal,
    };
  }
  const guardrailFailures: string[] = [];
  for (const rule of guardrails) {
    const leader = leaderMetrics[rule.name];
    const value = candidate.aggregatedMetrics[rule.name];
    if (leader === undefined || value === undefined) {
      guardrailFailures.push(`Guardrail metric ${rule.name} is missing`);
      continue;
    }
    if (rule.min !== undefined && value < rule.min) guardrailFailures.push(`${rule.name}=${value} is below minimum ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) guardrailFailures.push(`${rule.name}=${value} is above maximum ${rule.max}`);
    if (rule.maxRegression !== undefined) {
      const regression = rule.direction === "maximize" ? leader - value : value - leader;
      if (regression > rule.maxRegression) guardrailFailures.push(`${rule.name} regressed by ${regression}, over limit ${rule.maxRegression}`);
    }
  }
  if (guardrailFailures.length > 0) {
    return { status: "discard", primaryDelta: delta, reasons: guardrailFailures, ...(statisticalStatus ? { statisticalStatus } : {}), paretoOptimal };
  }
  if (statisticalStatus === "regression") {
    return {
      status: "discard",
      primaryDelta: delta,
      reasons: [`Statistical comparison classifies the candidate as a regression at confidence ${candidate.statisticalComparison!.confidenceLevel}`],
      statisticalStatus,
      paretoOptimal,
    };
  }
  if (statisticalStatus === "inconclusive") {
    return {
      status: "inconclusive",
      primaryDelta: delta,
      reasons: [`Evidence remains inconclusive after ${candidate.statisticalComparison!.sampleCount} paired seeds`],
      statisticalStatus,
      paretoOptimal,
    };
  }
  if (delta >= primary.minimumDelta) {
    if (candidate.statisticalComparison && statisticalStatus !== "improvement") {
      return {
        status: paretoOptimal ? "retain" : "discard",
        primaryDelta: delta,
        reasons: [`Aggregate improvement ${delta.toPrecision(6)} was not statistically confirmed (${statisticalStatus})`],
        ...(statisticalStatus ? { statisticalStatus } : {}),
        paretoOptimal,
      };
    }
    return {
      status: "promote",
      primaryDelta: delta,
      reasons: [`Primary improvement ${delta.toPrecision(6)} promotes the global leader`, ...(statisticalStatus ? [`Statistical status: ${statisticalStatus}`] : [])],
      ...(statisticalStatus ? { statisticalStatus } : {}),
      paretoOptimal,
    };
  }

  if (paretoOptimal) {
    return {
      status: "retain",
      primaryDelta: delta,
      reasons: ["Candidate is Pareto-optimal across configured objectives despite not promoting the primary leader"],
      ...(statisticalStatus ? { statisticalStatus } : {}),
      paretoOptimal: true,
    };
  }

  const regressionRatio = delta >= 0 ? 0 : -delta / Math.max(Math.abs(leaderPrimary), 1e-12);
  if (branchDepth <= maxBranchDepth && regressionRatio <= maxTemporaryRegressionRatio) {
    reasons.push(`Candidate retained for exploration at branch depth ${branchDepth}`);
    reasons.push(`Temporary primary regression ratio ${regressionRatio.toPrecision(4)} is within ${maxTemporaryRegressionRatio}`);
    return { status: "retain", primaryDelta: delta, reasons, ...(statisticalStatus ? { statisticalStatus } : {}), paretoOptimal };
  }
  if (branchDepth > maxBranchDepth) reasons.push(`Branch depth ${branchDepth} exceeds ${maxBranchDepth}`);
  if (regressionRatio > maxTemporaryRegressionRatio) {
    reasons.push(`Temporary primary regression ratio ${regressionRatio.toPrecision(4)} exceeds ${maxTemporaryRegressionRatio}`);
  }
  if (reasons.length === 0) reasons.push(`Primary improvement ${delta.toPrecision(6)} is below required ${primary.minimumDelta}`);
  return { status: "discard", primaryDelta: delta, reasons, ...(statisticalStatus ? { statisticalStatus } : {}), paretoOptimal };
}
