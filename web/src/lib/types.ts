export type Direction = "minimize" | "maximize";
export type MetricFormat = "number" | "percentage";
export type DecisionStatus = "promote" | "retain" | "discard" | "failure" | "inconclusive" | "pruned" | "keep" | "reject";
export type ComparisonStatus = "improvement" | "regression" | "equivalent" | "inconclusive";
export type RunStatus = "running" | "paused" | "completed" | "failed" | "interrupted" | "stopped";

export interface MetricConfig {
  name: string;
  direction: Direction;
  format?: MetricFormat;
  minimumDelta?: number;
  aggregation?: string;
  weight?: number;
}

export interface MetricStatistics {
  count: number;
  mean: number;
  median: number;
  variance: number;
  standardDeviation: number;
  standardError: number;
  minimum: number;
  maximum: number;
  confidenceLevel: number;
  confidenceInterval: { lower: number; upper: number };
}

export interface StatisticalComparison {
  status: ComparisonStatus;
  direction: Direction;
  confidenceLevel: number;
  sampleCount: number;
  improvement: number;
  confidenceInterval: { lower: number; upper: number };
  minimumDelta: number;
  equivalenceMargin: number;
}

export interface EvaluationAttempt {
  repetition: number;
  seed: number;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  durationMs: number;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  error?: string;
  stage?: string;
  budgetRatio?: number;
  stdoutPath?: string;
  stderrPath?: string;
  metricsPath?: string;
  cacheHit?: boolean;
  checkpointManifestPath?: string;
  phaseEvents?: Array<{ timestamp: string; phase: string; status: string; durationMs?: number; progress?: number; metadata?: Record<string, unknown> }>;
}

export interface EvaluationStageResult {
  name: string;
  budgetRatio: number;
  ok: boolean;
  attempts: EvaluationAttempt[];
  aggregatedMetrics: Record<string, number>;
  statistics: Record<string, MetricStatistics>;
  comparison?: StatisticalComparison;
  pruned: boolean;
  error?: string;
}

export interface EvaluationResult {
  ok: boolean;
  skipped?: boolean;
  pruned?: boolean;
  inconclusive?: boolean;
  attempts: EvaluationAttempt[];
  aggregatedMetrics: Record<string, number>;
  statistics?: Record<string, MetricStatistics>;
  statisticalComparison?: StatisticalComparison;
  stages?: EvaluationStageResult[];
  totalDurationMs?: number;
  computeSavedRatio?: number;
  cacheHits?: number;
  cacheMisses?: number;
  phaseDurationsMs?: Record<string, number>;
  preflight?: { ok: boolean; durationMs: number; error?: string };
  error?: string;
}

export interface AblationSpec {
  sourceExperimentId: string;
  removePath: string;
}

export interface MergeSpec {
  sourceExperimentIds: [string, string];
  pathsFromSecond: string[];
}

export interface EnsembleSpec { sourceExperimentIds: string[] }

export interface ExperimentPlan {
  hypothesis: string;
  changeCategory: string;
  expectedEffect: string;
  notes: string[];
  lessonsUsed: string[];
  contradictedLessons: string[];
  lessonTests: string[];
  questionsAddressed: string[];
  evaluationRequest?: { mode: "paired"; seeds: number[]; rationale: string };
  expectedGain?: number;
  probabilityOfSuccess?: number;
  informationGain?: number;
  estimatedCost?: number;
  falsificationCriterion?: string;
  dependencies?: string[];
  followUpHypotheses?: string[];
  searchSuggestion?: Record<string, string | number | boolean>;
  ablation?: AblationSpec;
  merge?: MergeSpec;
  ensemble?: EnsembleSpec;
  resourceRequest?: { cpu?: number; memoryGb?: number; gpu?: number; vramGb?: number };
}

export interface ProposalReview {
  approved: boolean;
  summary: string;
  concerns: string[];
}

export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ExperimentAccounting {
  durationMs: number;
  evaluatorDurationMs: number;
  agentUsage: AgentUsage;
  primaryImprovement: number | null;
  relativePrimaryImprovement: number | null;
  costPerImprovementUsd: number | null;
  timePerImprovementMs: number | null;
}

export interface PairedEvaluation {
  referenceId: string;
  seeds: number[];
  rationale: string;
  reference: EvaluationResult;
  candidate: EvaluationResult;
  decision: {
    status: DecisionStatus;
    primaryDelta: number | null;
    reasons: string[];
    statisticalStatus?: ComparisonStatus;
  };
}

export interface ExperimentRecord {
  id: string;
  index: number;
  startedAt: string;
  finishedAt: string;
  parentId?: string;
  strategy?: string;
  branchDepth?: number;
  changedPaths: string[];
  forbiddenChanges: string[];
  duplicateOf?: string;
  repeatedHypothesisOf?: string;
  targetLessonId?: string;
  targetQuestionId?: string;
  ticketId?: string;
  agentProfileId?: string;
  plan?: ExperimentPlan;
  conclusion?: {
    narrative: string;
    summary: string;
    notes: string[];
    nextHypotheses: string[];
  };
  proposalReview?: ProposalReview;
  evaluation: EvaluationResult;
  pairedEvaluation?: PairedEvaluation;
  decision: {
    status: DecisionStatus;
    primaryDelta: number | null;
    reasons: string[];
    statisticalStatus?: ComparisonStatus;
    paretoOptimal?: boolean;
  };
  accounting?: ExperimentAccounting;
}

export interface ResearchNode {
  id: string;
  parentId?: string;
  metrics: Record<string, number>;
  branchDepth?: number;
  status: "leader" | "frontier" | "retired" | "discarded" | "failed";
  wasLeader: boolean;
  strategy: string;
  changeCategory: string;
  paretoOptimal?: boolean;
  sourceIds?: string[];
  selectedCount?: number;
}

export interface CampaignTicket {
  id: string;
  kind?: "hypothesis" | "ablation" | "merge" | "search" | "ensemble" | "slice";
  type?: "hypothesis" | "ablation" | "merge" | "search" | "ensemble" | "slice";
  title?: string;
  hypothesis: string;
  status: "queued" | "running" | "completed" | "cancelled" | "blocked";
  createdAt: string;
  updatedAt: string;
  createdBy?: "agent" | "harness" | "human" | "meta";
  dependencies: string[];
  expectedGain: number;
  probabilityOfSuccess?: number;
  probability?: number;
  informationGain: number;
  estimatedCost: number;
  priority?: number;
  priorityScore?: number;
  claimedBy?: string;
  resultExperimentId?: string;
  cancellationReason?: string;
  blockedReason?: string;
  ablation?: AblationSpec;
  merge?: MergeSpec;
  ensemble?: EnsembleSpec;
  searchSuggestion?: Record<string, string | number | boolean>;
  learnedPriority?: number;
  predictedDurationMs?: number;
  predictedImprovement?: number;
}

export interface ResearchCampaign {
  schemaVersion: number;
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  tickets: CampaignTicket[];
}

export interface AgentPerformance {
  profileId: string;
  trials: number;
  totalReward: number;
  meanReward: number;
  promotions: number;
  failures: number;
}

export interface StrategyPerformance {
  strategy: string;
  trials: number;
  totalReward: number;
  meanReward: number;
}

export interface MetaResearchState {
  schemaVersion: number;
  agentPerformance: AgentPerformance[];
  strategyPerformance: StrategyPerformance[];
  policyUpdates: Array<{
    experimentIndex: number;
    reason: string;
    strategyRates: Record<string, number>;
    createdAt: string;
  }>;
}

export interface RunState {
  schemaVersion?: number;
  runId: string;
  name: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  stopReason?: string;
  control?: { desiredState: "running" | "paused" | "stopped"; updatedAt: string; reason?: string; ownerPid?: number; heartbeatAt?: string };
  agent?: { model?: string; thinkingLevel?: string; profileId?: string };
  primaryMetric?: MetricConfig;
  guardrails?: MetricConfig[];
  objectives?: MetricConfig[];
  baseline: EvaluationResult;
  acceptedMetrics: Record<string, number>;
  bestObserved?: {
    experimentId: string;
    metrics: Record<string, number>;
    decisionStatus: DecisionStatus | "baseline";
  };
  bestByObjective?: Record<string, { experimentId: string; value: number }>;
  researchGraph?: {
    leaderId: string;
    frontierIds: string[];
    paretoFrontierIds?: string[];
    nodes: ResearchNode[];
  };
  campaign?: ResearchCampaign;
  metaResearch?: MetaResearchState;
  researchMemory?: {
    facts: Array<{ id: string; experimentId: string; statement: string; metrics?: Record<string, number> }>;
    notes: Array<{ id: string; experimentId: string; text: string; phase: string }>;
    lessons: Array<{ id: string; claim: string; status: string; confidence: number; guidance: string }>;
    questions: Array<{ id: string; text: string; status: string; resolution?: string }>;
    evidenceReviews: Array<{ experimentId: string; lessonId: string; accepted: boolean; reason: string }>;
  };
  experiments: ExperimentRecord[];
}

export interface LiveProgressEvent {
  sequence: number;
  timestamp: string;
  message: string;
}

export type AgentTranscriptActor = "implementer" | "reviewer" | "harness" | "system";
export type AgentTranscriptPhase = "proposal" | "proposal_review" | "reflection";
export type AgentTranscriptKind = "lifecycle" | "prompt" | "thinking" | "message" | "tool" | "tool_result" | "error";

export interface AgentTranscriptEntry {
  sequence: number;
  id: string;
  timestamp: string;
  updatedAt: string;
  phase: AgentTranscriptPhase;
  actor: AgentTranscriptActor;
  kind: AgentTranscriptKind;
  title: string;
  content?: string;
  data?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface AgentTranscriptSnapshot {
  schemaVersion: 1;
  experimentId: string;
  active: boolean;
  updatedAt: string;
  entries: AgentTranscriptEntry[];
}

export interface ActiveExperimentSummary {
  id: string;
  startedAt: string;
  transcriptEntries: number;
  latestActivityAt: string;
  parentId?: string;
  strategy?: string;
  branchDepth?: number;
  sourceIds?: string[];
}

export interface DashboardSnapshot {
  schemaVersion: number;
  updatedAt: string;
  run: RunState | null;
  phase: LiveProgressEvent | null;
  progress: LiveProgressEvent[];
  activeExperiments: ActiveExperimentSummary[];
}

export interface ExperimentDetail {
  experiment: ExperimentRecord | null;
  active: boolean;
  proposal: string | null;
  conclusion: string | null;
}
