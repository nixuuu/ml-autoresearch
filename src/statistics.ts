/**
 * Small, dependency-free statistical primitives used by the research loop.
 *
 * The module deliberately does not depend on the harness domain types. This
 * keeps the statistical decisions usable by evaluators, reports, and future
 * orchestration layers without coupling those layers to one another.
 */

export type StatisticalDirection = "minimize" | "maximize";
export type ConfidenceIntervalMethod = "student-t" | "bootstrap";
export type BootstrapStatistic = "mean" | "median";
export type MetricAggregation = "mean" | "median" | "min" | "max";
export type ComparisonStatus = "improvement" | "regression" | "equivalent" | "inconclusive";

export interface StatisticalSummary {
  /** Number of observations. */
  n: number;
  mean: number;
  median: number;
  /** Unbiased sample variance (zero for a single observation). */
  variance: number;
  stddev: number;
  stderr: number;
  min: number;
  max: number;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidenceLevel: number;
  marginOfError: number;
  /** Null for a percentile bootstrap interval. */
  criticalValue: number | null;
  method: ConfidenceIntervalMethod | "degenerate";
}

export interface ConfidenceIntervalOptions {
  confidenceLevel?: number;
  method?: ConfidenceIntervalMethod;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
  bootstrapStatistic?: BootstrapStatistic;
}

export interface PairedComparisonOptions {
  direction: StatisticalDirection;
  /** Required improvement, expressed in the oriented (positive-is-better) scale. */
  minimumDelta?: number;
  /** Differences inside this symmetric band are practically equivalent. */
  equivalenceMargin?: number;
  confidenceLevel?: number;
  confidenceMethod?: ConfidenceIntervalMethod;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
}

export interface PairedComparisonResult {
  status: ComparisonStatus;
  direction: StatisticalDirection;
  n: number;
  /** Per-pair differences, oriented so a positive value is an improvement. */
  differences: number[];
  reference: StatisticalSummary;
  candidate: StatisticalSummary;
  difference: StatisticalSummary;
  confidenceInterval: ConfidenceInterval;
  /** Mean oriented difference. */
  estimate: number;
  /** Alias useful when adapting the result to a harness decision. */
  primaryDelta: number;
  minimumDelta: number;
  equivalenceMargin: number;
  reason: string;
}

const DEFAULT_CONFIDENCE_LEVEL = 0.95;
const DEFAULT_BOOTSTRAP_ITERATIONS = 2_000;
const DEFAULT_BOOTSTRAP_SEED = 0x6d2b79f5;

function finiteSample(values: readonly number[], label: string): number[] {
  if (values.length === 0) throw new Error(`${label} must contain at least one observation`);
  const copy = [...values];
  for (const value of copy) {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite observation`);
  }
  return copy;
}

function validateConfidenceLevel(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`confidenceLevel must be greater than 0 and less than 1; received ${value}`);
  }
  return value;
}

function validateNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

/**
 * Summarize a finite sample. Variance uses the unbiased (n - 1) denominator;
 * for n=1 it is defined as zero because there is no observed spread.
 */
export function summarize(values: readonly number[]): StatisticalSummary {
  const sample = finiteSample(values, "values");
  const n = sample.length;
  const sorted = [...sample].sort((a, b) => a - b);
  const mean = sample.reduce((sum, value) => sum + value, 0) / n;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const squaredDeviation = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const variance = n > 1 ? Math.max(0, squaredDeviation / (n - 1)) : 0;
  const stddev = Math.sqrt(variance);
  return {
    n,
    mean,
    median,
    variance,
    stddev,
    stderr: stddev / Math.sqrt(n),
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

/** Alias with a descriptive name for call sites that prefer it. */
export const summarizeSample = summarize;

/* Abramowitz-Stegun / Peter Acklam style inverse normal approximation. */
function inverseNormal(probability: number): number {
  if (probability <= 0 || probability >= 1) {
    throw new Error(`probability must be greater than 0 and less than 1; received ${probability}`);
  }
  const a = [
    -39.6968302866538,
    220.946098424521,
    -275.928510446969,
    138.357751867269,
    -30.6647980661472,
    2.50662827745924,
  ];
  const b = [
    -54.4760987982241,
    161.585836858041,
    -155.698979859887,
    66.8013118877197,
    -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029,
    -0.322396458041136,
    -2.40075827716184,
    -2.54973253934373,
    4.37466414146497,
    2.93816398269878,
  ];
  const d = [
    0.00778469570904146,
    0.32246712907004,
    2.445134137143,
    3.75440866190742,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    const numerator = ((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!;
    const denominator = (((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1;
    return numerator / denominator;
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    const numerator = ((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!;
    const denominator = (((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1;
    return -numerator / denominator;
  }
  const q = probability - 0.5;
  const r = q * q;
  const numerator = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q;
  const denominator = (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + b[5]!) * r + 1;
  return numerator / denominator;
}

/* Lanczos log-gamma, used to calculate an accurate Student-t critical value. */
function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let x = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index]! / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const minValue = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < minValue) d = minValue;
  d = 1 / d;
  let h = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const m = iteration;
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < minValue) d = minValue;
    c = 1 + aa / c;
    if (Math.abs(c) < minValue) c = minValue;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < minValue) d = minValue;
    c = 1 + aa / c;
    if (Math.abs(c) < minValue) c = minValue;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= epsilon) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBetaTerm = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const betaTerm = Math.exp(logBetaTerm);
  if (x < (a + 1) / (a + b + 2)) return betaTerm * betaContinuedFraction(x, a, b) / a;
  return 1 - (betaTerm * betaContinuedFraction(1 - x, b, a)) / b;
}

function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (value === 0) return 0.5;
  if (value < 0) return 1 - studentTCdf(-value, degreesOfFreedom);
  const x = degreesOfFreedom / (degreesOfFreedom + value * value);
  return 1 - 0.5 * regularizedBeta(x, degreesOfFreedom / 2, 0.5);
}

function studentTCritical(confidenceLevel: number, degreesOfFreedom: number): number {
  const target = (1 + confidenceLevel) / 2;
  let lower = 0;
  let upper = 1;
  while (studentTCdf(upper, degreesOfFreedom) < target && upper < 1e12) upper *= 2;
  for (let iteration = 0; iteration < 90; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < target) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 1) return sortedValues[0]!;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower]!;
  const fraction = position - lower;
  return sortedValues[lower]! + (sortedValues[upper]! - sortedValues[lower]!) * fraction;
}

function nextRandom(state: { value: number }): number {
  // xorshift32 is tiny, deterministic, and sufficient for resampling.
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value / 0x1_0000_0000;
}

interface BootstrapIntervalOptions {
  confidenceLevel: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
  bootstrapStatistic?: BootstrapStatistic;
}

function bootstrapInterval(sample: readonly number[], options: BootstrapIntervalOptions): ConfidenceInterval {
  const statistic = options.bootstrapStatistic ?? "mean";
  const state = { value: (options.bootstrapSeed >>> 0) || DEFAULT_BOOTSTRAP_SEED };
  const estimates = new Array<number>(options.bootstrapIterations);
  for (let iteration = 0; iteration < options.bootstrapIterations; iteration += 1) {
    const resample = new Array<number>(sample.length);
    for (let index = 0; index < sample.length; index += 1) resample[index] = sample[Math.floor(nextRandom(state) * sample.length)]!;
    estimates[iteration] = statistic === "median" ? summarize(resample).median : resample.reduce((sum, value) => sum + value, 0) / resample.length;
  }
  estimates.sort((a, b) => a - b);
  const alpha = (1 - options.confidenceLevel) / 2;
  const lower = quantile(estimates, alpha);
  const upper = quantile(estimates, 1 - alpha);
  const estimate = statistic === "median" ? summarize(sample).median : summarize(sample).mean;
  return {
    lower,
    upper,
    confidenceLevel: options.confidenceLevel,
    marginOfError: Math.max(Math.abs(estimate - lower), Math.abs(upper - estimate)),
    criticalValue: null,
    method: "bootstrap",
  };
}

/**
 * Calculate a two-sided confidence interval for the sample mean (or a
 * deterministic percentile-bootstrap interval). For n=1 the interval is
 * intentionally degenerate and reports no unobserved uncertainty.
 */
export function confidenceInterval(values: readonly number[], confidenceLevelOrOptions: number | ConfidenceIntervalOptions = DEFAULT_CONFIDENCE_LEVEL): ConfidenceInterval {
  const sample = finiteSample(values, "values");
  const options: ConfidenceIntervalOptions = typeof confidenceLevelOrOptions === "number"
    ? { confidenceLevel: confidenceLevelOrOptions }
    : confidenceLevelOrOptions;
  const confidenceLevel = validateConfidenceLevel(options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL);
  if (options.method === "bootstrap") {
    const iterations = options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
    if (!Number.isInteger(iterations) || iterations < 1) throw new Error("bootstrapIterations must be a positive integer");
    const seed = options.bootstrapSeed ?? DEFAULT_BOOTSTRAP_SEED;
    if (!Number.isFinite(seed)) throw new Error("bootstrapSeed must be finite");
    const bootstrapOptions: BootstrapIntervalOptions = {
      confidenceLevel,
      bootstrapIterations: iterations,
      bootstrapSeed: seed,
    };
    if (options.bootstrapStatistic !== undefined) bootstrapOptions.bootstrapStatistic = options.bootstrapStatistic;
    return bootstrapInterval(sample, bootstrapOptions);
  }
  const summary = summarize(sample);
  if (summary.n === 1) {
    return {
      lower: summary.mean,
      upper: summary.mean,
      confidenceLevel,
      marginOfError: 0,
      criticalValue: null,
      method: "degenerate",
    };
  }
  const criticalValue = studentTCritical(confidenceLevel, summary.n - 1);
  const marginOfError = criticalValue * summary.stderr;
  return {
    lower: summary.mean - marginOfError,
    upper: summary.mean + marginOfError,
    confidenceLevel,
    marginOfError,
    criticalValue,
    method: "student-t",
  };
}

/** Orient a candidate-reference difference so positive always means better. */
export function orientDifference(reference: number, candidate: number, direction: StatisticalDirection): number {
  if (!Number.isFinite(reference) || !Number.isFinite(candidate)) throw new Error("reference and candidate must be finite");
  return direction === "maximize" ? candidate - reference : reference - candidate;
}

function comparisonStatus(lower: number, upper: number, minimumDelta: number, equivalenceMargin: number): ComparisonStatus {
  // Strict comparisons at zero preserve an exact no-change result as equivalent.
  if (lower > minimumDelta && lower > equivalenceMargin) return "improvement";
  if (upper < -equivalenceMargin) return "regression";
  if (lower >= -equivalenceMargin && upper <= equivalenceMargin) return "equivalent";
  return "inconclusive";
}

/**
 * Compare paired reference/candidate observations. Pairing is important: the
 * confidence interval is calculated over per-seed differences, which removes
 * common seed noise and makes the result suitable for promotion decisions.
 */
export function comparePairedSamples(
  referenceValues: readonly number[],
  candidateValues: readonly number[],
  options: PairedComparisonOptions,
): PairedComparisonResult {
  const reference = finiteSample(referenceValues, "referenceValues");
  const candidate = finiteSample(candidateValues, "candidateValues");
  if (reference.length !== candidate.length) throw new Error("referenceValues and candidateValues must have the same length");
  if (options.direction !== "minimize" && options.direction !== "maximize") throw new Error(`Unsupported direction: ${String(options.direction)}`);
  const minimumDelta = validateNonNegative(options.minimumDelta ?? 0, "minimumDelta");
  const equivalenceMargin = validateNonNegative(options.equivalenceMargin ?? 0, "equivalenceMargin");
  const differences = reference.map((value, index) => orientDifference(value, candidate[index]!, options.direction));
  const difference = summarize(differences);
  const intervalOptions: ConfidenceIntervalOptions = {};
  if (options.confidenceLevel !== undefined) intervalOptions.confidenceLevel = options.confidenceLevel;
  if (options.confidenceMethod !== undefined) intervalOptions.method = options.confidenceMethod;
  if (options.bootstrapIterations !== undefined) intervalOptions.bootstrapIterations = options.bootstrapIterations;
  if (options.bootstrapSeed !== undefined) intervalOptions.bootstrapSeed = options.bootstrapSeed;
  const interval = confidenceInterval(differences, intervalOptions);
  const status = differences.length < 2
    ? "inconclusive"
    : comparisonStatus(interval.lower, interval.upper, minimumDelta, equivalenceMargin);
  const reason = differences.length < 2
    ? "At least two independent paired observations are required for a confidence-based decision"
    : status === "improvement"
    ? `Confidence interval [${interval.lower.toPrecision(6)}, ${interval.upper.toPrecision(6)}] clears the required improvement ${minimumDelta}`
    : status === "regression"
      ? `Confidence interval [${interval.lower.toPrecision(6)}, ${interval.upper.toPrecision(6)}] exceeds the regression margin ${equivalenceMargin}`
      : status === "equivalent"
        ? `Confidence interval [${interval.lower.toPrecision(6)}, ${interval.upper.toPrecision(6)}] is within the equivalence margin ${equivalenceMargin}`
        : `Confidence interval [${interval.lower.toPrecision(6)}, ${interval.upper.toPrecision(6)}] is inconclusive for the configured thresholds`;
  return {
    status,
    direction: options.direction,
    n: reference.length,
    differences,
    reference: summarize(reference),
    candidate: summarize(candidate),
    difference,
    confidenceInterval: interval,
    estimate: difference.mean,
    primaryDelta: difference.mean,
    minimumDelta,
    equivalenceMargin,
    reason,
  };
}

/** Alias emphasizing that the comparison is paired by seed/repetition. */
export const comparePaired = comparePairedSamples;

/** Aggregate one or more samples for each named metric. */
export function aggregateMetricSamples(
  metricSamples: Record<string, readonly number[]>,
  aggregations: Partial<Record<string, MetricAggregation>> = {},
): Record<string, number> {
  return Object.fromEntries(Object.entries(metricSamples).map(([name, values]) => {
    const summary = summarize(values);
    const aggregation = aggregations[name] ?? "mean";
    const value = aggregation === "mean"
      ? summary.mean
      : aggregation === "median"
        ? summary.median
        : aggregation === "min"
          ? summary.min
          : aggregation === "max"
            ? summary.max
            : undefined;
    if (value === undefined) throw new Error(`Unsupported aggregation for metric ${name}: ${String(aggregation)}`);
    return [name, value];
  }));
}

/** Common shorter name for callers aggregating evaluator output. */
export const aggregateMetrics = aggregateMetricSamples;
