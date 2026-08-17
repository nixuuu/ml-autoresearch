export type Direction = "minimize" | "maximize";
export type Aggregation = "mean" | "median" | "min" | "max";
export type MetricFormat = "number" | "percentage";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ResearchStrategy = "exploit" | "explore" | "backtrack" | "replicate" | "falsify" | "optimize" | "ablate" | "merge" | "ensemble";
export type ResearchDecisionStatus = "promote" | "retain" | "discard" | "failure" | "inconclusive" | "pruned";
export type LessonStatus = "tentative" | "supported" | "contradicted" | "retired" | "human-approved";
export type LessonGuidance = "consider" | "avoid" | "verify";
export type ChangeCategory =
  | "model-architecture"
  | "regularization"
  | "optimization"
  | "data"
  | "features"
  | "objective"
  | "training-budget"
  | "inference"
  | "evaluation"
  | "other";
export type QuestionStatus = "open" | "resolved" | "invalidated";

export interface PrimaryMetricConfig {
  name: string;
  direction: Direction;
  format?: MetricFormat;
  minimumDelta: number;
  aggregation: Aggregation;
}

export interface GuardrailMetricConfig {
  name: string;
  direction: Direction;
  format?: MetricFormat;
  aggregation: Aggregation;
  maxRegression?: number;
  min?: number;
  max?: number;
}

export interface ObjectiveMetricConfig {
  name: string;
  direction: Direction;
  format?: MetricFormat;
  aggregation: Aggregation;
  weight: number;
}

export interface AgentProfileConfig {
  id: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt?: string;
}

export interface AgentAnalysisConfig {
  enabled: boolean;
  timeoutSeconds: number;
  maxCalls: number;
  maxOutputBytes: number;
  inheritEnv: string[];
  env: Record<string, string>;
  runner: {
    mode: "local" | "docker";
    image?: string;
    allowHostExecution: boolean;
    cpus?: number;
    memory?: string;
    network: string;
    gpus?: string;
    readOnlyRoot: boolean;
    pidsLimit: number;
  };
}

export type AgentRole = "implementer" | "reviewer";

export interface EvaluationStageConfig {
  name: string;
  budgetRatio: number;
  repetitions?: number;
  timeoutSeconds?: number;
  pruneIfClearlyWorse: boolean;
}

export interface EvaluatorPreflightConfig {
  enabled: boolean;
  command: string[];
  timeoutSeconds: number;
}

export interface EvaluatorCheckpointConfig {
  enabled: boolean;
  manifestName: string;
}

export interface EvaluatorTelemetryConfig {
  enabled: boolean;
}

export interface ResourceConfig {
  id: string;
  cpu: number;
  memoryGb: number;
  gpu: number;
  vramGb: number;
  maxConcurrent: number;
}

export interface AshaSchedulerConfig {
  enabled: boolean;
  familySize: number;
  reductionFactor: number;
  agentCandidates: boolean;
}

export interface SurrogateSearchConfig {
  enabled: boolean;
  minimumObservations: number;
  candidatePoolSize: number;
  explorationWeight: number;
}

export interface ParameterSweepPolicyConfig {
  enabled: boolean;
  maxValues: number;
  maxConcurrentTrials: number;
  reductionFactor: number;
}

export interface LearnedAcquisitionConfig {
  enabled: boolean;
  minimumObservations: number;
  explorationFloor: number;
}

export interface EnsemblePolicyConfig {
  enabled: boolean;
  minimumMembers: number;
  maximumMembers: number;
  interval: number;
}

export interface SliceDiscoveryConfig {
  enabled: boolean;
  minimumSamples: number;
  maximumTickets: number;
  regressionThreshold: number;
}

export interface StatisticalPolicyConfig {
  enabled: boolean;
  confidenceLevel: number;
  equivalenceMargin: number;
  minimumSeeds: number;
  maximumSeeds: number;
  seedStep: number;
}

export interface SearchParameterConfig {
  name: string;
  file: string;
  path: string;
  type: "float" | "integer" | "categorical" | "boolean";
  min?: number;
  max?: number;
  scale?: "linear" | "log";
  values?: Array<string | number | boolean>;
}

export interface CampaignPolicyConfig {
  enabled: boolean;
  queueRate: number;
  maxQueued: number;
  hypothesesPerProposal: number;
  autoAblations: boolean;
  maxAblationsPerPromotion: number;
  autoMerge: boolean;
}

export interface KnowledgePolicyConfig {
  enabled: boolean;
  path: string;
  scope: Record<string, string>;
  minimumConfidence: number;
}

export interface MetaResearchConfig {
  enabled: boolean;
  updateInterval: number;
  warmupExperiments: number;
  explorationFloor: number;
}

export interface HarnessConfig {
  version: 2;
  name: string;
  project: {
    sourceDir: string;
    mutablePaths: string[];
    protectedPaths: string[];
    hiddenPaths: string[];
    copyIgnore: string[];
  };
  agent: {
    model?: string;
    thinkingLevel: ThinkingLevel;
    systemPrompt?: string;
    pool?: AgentProfileConfig[];
    roles?: Partial<Record<AgentRole, AgentProfileConfig>>;
    analysis?: AgentAnalysisConfig;
  };
  evaluator: {
    command: string[];
    timeoutSeconds: number;
    repetitions: number;
    seeds: number[];
    inheritEnv: string[];
    env: Record<string, string>;
    stages?: EvaluationStageConfig[];
    statistics?: StatisticalPolicyConfig;
    repetitionConcurrency?: number;
    preflight?: EvaluatorPreflightConfig;
    checkpointing?: EvaluatorCheckpointConfig;
    telemetry?: EvaluatorTelemetryConfig;
    cache?: {
      enabled: boolean;
      path: string;
      namespace: string;
      readOnly: boolean;
      results?: boolean;
    };
    agentRequests?: {
      allowPairedComparison: boolean;
      maxSeeds: number;
    };
    runner: {
      mode: "local" | "docker";
      image?: string;
      cpus?: number;
      memory?: string;
      network: string;
      gpus?: string;
      readOnlyRoot: boolean;
      pidsLimit: number;
    };
  };
  metrics: {
    primary: PrimaryMetricConfig;
    guardrails: GuardrailMetricConfig[];
    objectives?: ObjectiveMetricConfig[];
    pareto?: { enabled: boolean };
  };
  budget: {
    maxExperiments: number;
    maxWallTimeMinutes: number;
    maxConsecutiveFailures: number;
  };
  learning: {
    beamWidth: number;
    maxBranchDepth: number;
    maxTemporaryRegressionRatio: number;
    recentExperiments: number;
    maxContextLessons: number;
    supportThreshold: number;
    contradictionThreshold: number;
    maxFrontierPerCategory: number;
    strategy: {
      explorationRate: number;
      backtrackRate: number;
      replicationRate: number;
      falsificationRate: number;
      optimizeRate?: number;
      mergeRate?: number;
      ablationRate?: number;
    };
    humanLessons: Array<{
      id: string;
      claim: string;
      guidance: LessonGuidance;
    }>;
    campaign?: CampaignPolicyConfig;
    meta?: MetaResearchConfig;
    acquisition?: LearnedAcquisitionConfig;
    ensemble?: EnsemblePolicyConfig;
    sliceDiscovery?: SliceDiscoveryConfig;
  };
  search?: {
    enabled: boolean;
    seed: number;
    exploitationRatio: number;
    parameters: SearchParameterConfig[];
    surrogate?: SurrogateSearchConfig;
    sweeps?: ParameterSweepPolicyConfig;
  };
  execution?: {
    experimentConcurrency: number;
    resourceSlots: string[];
    resources?: ResourceConfig[];
    asha?: AshaSchedulerConfig;
  };
  knowledge?: KnowledgePolicyConfig;
  outputDir: string;
  researchInstructions: string;
}

export interface PairedEvaluationRequest {
  mode: "paired";
  seeds: number[];
  rationale: string;
}

export type SweepValue = string | number | boolean;

export interface ParameterSweepRequest {
  mode: "parameter_sweep";
  parameter: string;
  values: SweepValue[];
  rationale: string;
}

export type AgentEvaluationRequest = PairedEvaluationRequest | ParameterSweepRequest;

export interface MetricPayload {
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface EvaluationAttempt {
  repetition: number;
  seed: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  error?: string;
  stdoutPath: string;
  stderrPath: string;
  metricsPath: string;
  stage?: string;
  budgetRatio?: number;
  cacheHit?: boolean;
  phaseEvents?: EvaluationPhaseEvent[];
  checkpointManifestPath?: string;
}

export interface EvaluationPhaseEvent {
  timestamp: string;
  phase: string;
  status: "started" | "progress" | "completed" | "failed";
  durationMs?: number;
  progress?: number;
  metadata?: Record<string, unknown>;
}

export interface PreflightResult {
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
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
  status: "improvement" | "regression" | "equivalent" | "inconclusive";
  direction: Direction;
  confidenceLevel: number;
  sampleCount: number;
  improvement: number;
  confidenceInterval: { lower: number; upper: number };
  minimumDelta: number;
  equivalenceMargin: number;
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
  attempts: EvaluationAttempt[];
  aggregatedMetrics: Record<string, number>;
  error?: string;
  skipped?: boolean;
  pruned?: boolean;
  inconclusive?: boolean;
  stages?: EvaluationStageResult[];
  statistics?: Record<string, MetricStatistics>;
  statisticalComparison?: StatisticalComparison;
  totalDurationMs?: number;
  computeSavedRatio?: number;
  preflight?: PreflightResult;
  cacheHits?: number;
  cacheMisses?: number;
  phaseDurationsMs?: Record<string, number>;
}

export interface DecisionResult {
  status: ResearchDecisionStatus | "keep" | "reject";
  primaryDelta: number | null;
  reasons: string[];
  statisticalStatus?: StatisticalComparison["status"];
  paretoOptimal?: boolean;
}

export interface ExperimentPlan {
  hypothesis: string;
  changeCategory: ChangeCategory;
  expectedEffect: string;
  notes: string[];
  lessonsUsed: string[];
  contradictedLessons: string[];
  lessonTests: string[];
  questionsAddressed: string[];
  evaluationRequest?: AgentEvaluationRequest;
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
  resourceRequest?: ResourceRequest;
}

export interface AblationSpec {
  sourceExperimentId: string;
  removePath: string;
}

export interface MergeSpec {
  sourceExperimentIds: [string, string];
  pathsFromSecond: string[];
}

export interface EnsembleSpec {
  sourceExperimentIds: string[];
}

export interface ResourceRequest {
  cpu?: number;
  memoryGb?: number;
  gpu?: number;
  vramGb?: number;
}

export interface SliceMetricObservation {
  name: string;
  count: number;
  metrics: Record<string, number>;
  dimensions?: Record<string, string | number | boolean>;
}

export interface CampaignTicket {
  id: string;
  kind: "hypothesis" | "ablation" | "merge" | "search" | "ensemble" | "slice";
  hypothesis: string;
  status: "queued" | "running" | "completed" | "cancelled" | "blocked";
  createdAt: string;
  updatedAt: string;
  createdBy: "agent" | "harness" | "human" | "meta";
  dependencies: string[];
  expectedGain: number;
  probabilityOfSuccess: number;
  informationGain: number;
  estimatedCost: number;
  priority: number;
  claimedBy?: string;
  resultExperimentId?: string;
  cancellationReason?: string;
  ablation?: AblationSpec;
  merge?: MergeSpec;
  ensemble?: EnsembleSpec;
  searchSuggestion?: Record<string, string | number | boolean>;
  learnedPriority?: number;
  predictedDurationMs?: number;
  predictedImprovement?: number;
}

export interface ResearchCampaign {
  schemaVersion: 1;
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  tickets: CampaignTicket[];
}

export interface PairedEvaluationResult {
  referenceId: string;
  seeds: number[];
  rationale: string;
  reference: EvaluationResult;
  candidate: EvaluationResult;
  decision: DecisionResult;
}

export interface ParameterSweepTrial {
  id: string;
  value: SweepValue;
  status: "pending" | "evaluated" | "pruned" | "winner" | "failed";
  evaluation: EvaluationResult;
  decision: DecisionResult;
  prunedAtStage?: string;
  workspacePath: string;
  workspaceFingerprint: string;
}

export interface ParameterSweepResult {
  parameter: string;
  file: string;
  path: string;
  rationale: string;
  referenceValue?: SweepValue;
  trials: ParameterSweepTrial[];
  winnerTrialId?: string;
  selectedValue?: SweepValue;
  totalDurationMs: number;
  computeSavedRatio: number;
}

export interface LessonUpdate {
  lessonId?: string;
  claim: string;
  relation: "new" | "supports" | "contradicts" | "retire";
  guidance: LessonGuidance;
  confidence: number;
  evidenceKind: "direct" | "replication" | "contextual";
  evidenceRationale: string;
}

export interface ResearchQuestionUpdate {
  questionId: string;
  status: Exclude<QuestionStatus, "open">;
  resolution: string;
}

export interface ResearchConclusion {
  narrative: string;
  summary: string;
  notes: string[];
  lessonUpdates: LessonUpdate[];
  nextHypotheses: string[];
  questionUpdates: ResearchQuestionUpdate[];
}

export interface ResearchNote {
  id: string;
  experimentId: string;
  text: string;
  source: "agent";
  phase: "proposal" | "conclusion";
  createdAt: string;
}

export interface ResearchFact {
  id: string;
  experimentId: string;
  kind: "measurement" | "decision" | "duplicate";
  statement: string;
  parentId: string;
  strategy: ResearchStrategy;
  metrics: Record<string, number>;
  evidence: {
    repetitions: number;
    seeds: number[];
    primaryDelta: number | null;
    workspaceFingerprint: string;
  };
  createdAt: string;
}

export interface ResearchLesson {
  id: string;
  claim: string;
  normalizedClaim: string;
  status: LessonStatus;
  guidance: LessonGuidance;
  confidence: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResearchQuestion {
  id: string;
  text: string;
  normalizedText: string;
  status: QuestionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedBy?: string;
  resolution?: string;
}

export interface LessonEvidenceReview {
  experimentId: string;
  lessonId: string;
  relation: LessonUpdate["relation"];
  evidenceKind: LessonUpdate["evidenceKind"];
  accepted: boolean;
  reason: string;
  rationale: string;
  createdAt: string;
}

export interface ResearchMemory {
  schemaVersion: 3;
  updatedAt: string;
  facts: ResearchFact[];
  notes: ResearchNote[];
  lessons: ResearchLesson[];
  questions: ResearchQuestion[];
  evidenceReviews: LessonEvidenceReview[];
}

export interface ResearchNode {
  id: string;
  parentId?: string;
  workspacePath: string;
  workspaceFingerprint: string;
  metrics: Record<string, number>;
  branchDepth: number;
  status: "leader" | "frontier" | "retired" | "discarded" | "failed";
  wasLeader: boolean;
  strategy: ResearchStrategy;
  changeCategory: ChangeCategory | "baseline";
  selectedCount: number;
  paretoOptimal?: boolean;
  sourceIds?: string[];
}

export interface ResearchGraph {
  schemaVersion: 3;
  leaderId: string;
  frontierIds: string[];
  paretoFrontierIds: string[];
  nodes: ResearchNode[];
}

export interface ResearchAssignment {
  strategy: ResearchStrategy;
  parentId: string;
  parentWorkspacePath: string;
  parentMetrics: Record<string, number>;
  branchDepth: number;
  reason: string;
  targetLessonId?: string;
  targetQuestionId?: string;
  ticketId?: string;
  ablation?: AblationSpec;
  merge?: MergeSpec;
  ensemble?: EnsembleSpec;
  searchSuggestion?: Record<string, string | number | boolean>;
  plannedHypothesis?: string;
  resourceId?: string;
  resourceRequest?: ResourceRequest;
}

export interface ExperimentRecord {
  id: string;
  index: number;
  startedAt: string;
  finishedAt: string;
  workspacePath: string;
  proposalPath?: string;
  conclusionPath?: string;
  proposalJsonPath?: string;
  conclusionJsonPath?: string;
  parentId?: string;
  strategy?: ResearchStrategy;
  branchDepth?: number;
  plan?: ExperimentPlan;
  conclusion?: ResearchConclusion;
  workspaceFingerprint?: string;
  duplicateOf?: string;
  repeatedHypothesisOf?: string;
  targetLessonId?: string;
  targetQuestionId?: string;
  changedPaths: string[];
  forbiddenChanges: string[];
  evaluation: EvaluationResult;
  pairedEvaluation?: PairedEvaluationResult;
  parameterSweep?: ParameterSweepResult;
  decision: DecisionResult;
  ticketId?: string;
  agentProfileId?: string;
  proposalReview?: ProposalReview;
  accounting: ExperimentAccounting;
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

export interface ProposalReview {
  approved: boolean;
  summary: string;
  concerns: string[];
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
  strategy: ResearchStrategy;
  trials: number;
  totalReward: number;
  meanReward: number;
}

export interface MetaResearchState {
  schemaVersion: 1;
  agentPerformance: AgentPerformance[];
  strategyPerformance: StrategyPerformance[];
  policyUpdates: Array<{
    experimentIndex: number;
    reason: string;
    strategyRates: Partial<Record<ResearchStrategy, number>>;
    createdAt: string;
  }>;
}

export interface RunControl {
  desiredState: "running" | "paused" | "stopped";
  updatedAt: string;
  reason?: string;
  ownerPid?: number;
  heartbeatAt?: string;
}

export interface ProjectKnowledge {
  schemaVersion: 1;
  scopeFingerprint: string;
  scope: Record<string, string>;
  updatedAt: string;
  lessons: ResearchLesson[];
  sourceRuns: string[];
}

export interface RunState {
  schemaVersion: 6;
  runId: string;
  name: string;
  status: "running" | "paused" | "completed" | "failed" | "interrupted" | "stopped";
  startedAt: string;
  finishedAt?: string;
  configPath: string;
  runDir: string;
  sourceDir: string;
  agent?: {
    model?: string;
    thinkingLevel: ThinkingLevel;
    profileId?: string;
  };
  primaryMetric?: PrimaryMetricConfig;
  guardrails?: GuardrailMetricConfig[];
  objectives?: ObjectiveMetricConfig[];
  acceptedWorkspacePath: string;
  baseline: EvaluationResult;
  acceptedMetrics: Record<string, number>;
  bestObserved?: {
    experimentId: string;
    workspacePath: string;
    metrics: Record<string, number>;
    decisionStatus: ResearchDecisionStatus | "baseline";
  };
  researchMemory?: ResearchMemory;
  researchGraph?: ResearchGraph;
  campaign?: ResearchCampaign;
  control?: RunControl;
  metaResearch?: MetaResearchState;
  bestByObjective?: Record<string, { experimentId: string; value: number }>;
  appliedCommandIds?: string[];
  activeDurationMs?: number;
  activeSegmentStartedAt?: string;
  experiments: ExperimentRecord[];
  stopReason?: string;
}

export interface LiveProgressEvent {
  sequence: number;
  timestamp: string;
  message: string;
}

export type AgentTranscriptActor = "implementer" | "reviewer" | "harness" | "system";
export type AgentTranscriptPhase = "proposal" | "proposal_review" | "reflection";
export type AgentTranscriptKind = "lifecycle" | "prompt" | "thinking" | "message" | "tool" | "tool_result" | "error";

export interface AgentTranscriptMutation {
  timestamp: string;
  type: "agent_transcript";
  entryId: string;
  operation: "append" | "set";
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

export interface ActiveExperimentSummary {
  id: string;
  startedAt: string;
  transcriptEntries: number;
  latestActivityAt: string;
  parentId?: string;
  strategy?: ResearchStrategy;
  branchDepth?: number;
  sourceIds?: string[];
}

export interface AgentTranscriptSnapshot {
  schemaVersion: 1;
  experimentId: string;
  active: boolean;
  updatedAt: string;
  entries: AgentTranscriptEntry[];
}

export interface LiveDashboardSnapshot {
  schemaVersion: 2;
  updatedAt: string;
  run: RunState | null;
  phase: LiveProgressEvent | null;
  progress: LiveProgressEvent[];
  activeExperiments: ActiveExperimentSummary[];
}

export interface ResearchContext {
  experimentId: string;
  experimentIndex: number;
  workspacePath: string;
  mutablePaths: string[];
  protectedPaths: string[];
  primaryMetric: PrimaryMetricConfig;
  guardrails: GuardrailMetricConfig[];
  evaluationRequests: {
    allowPairedComparison: boolean;
    maxSeeds: number;
    canonicalSeeds: number[];
    allowParameterSweep: boolean;
    maxSweepValues: number;
    sweepParameters: Array<{ name: string; type: SearchParameterConfig["type"]; file: string; path: string; min?: number; max?: number; values?: SweepValue[] }>;
  };
  analysis: {
    enabled: boolean;
    runner: "local" | "docker";
    maxCalls: number;
    timeoutSeconds: number;
  };
  acceptedMetrics: Record<string, number>;
  assignment: ResearchAssignment;
  memory: ResearchMemory;
  previousExperiments: Array<{
    id: string;
    status: DecisionResult["status"];
    metrics: Record<string, number>;
    primaryDelta: number | null;
    strategy?: ResearchStrategy;
    parentId?: string;
    hypothesis?: string;
    conclusion?: string;
  }>;
  researchInstructions: string;
  campaign?: ResearchCampaign;
  agentRole?: AgentRole;
}

export interface ResearchProposal {
  narrative: string;
  plan?: ExperimentPlan;
  agent?: {
    model?: string;
    thinkingLevel: ThinkingLevel;
    profileId?: string;
  };
}

export interface ResearchOutcome {
  experimentId: string;
  changedPaths: string[];
  acceptedMetricsBefore: Record<string, number>;
  parentMetrics: Record<string, number>;
  assignment: ResearchAssignment;
  plan?: ExperimentPlan;
  evaluation: EvaluationResult;
  pairedEvaluation?: PairedEvaluationResult;
  parameterSweep?: ParameterSweepResult;
  decision: DecisionResult;
}

export interface Researcher {
  propose(context: ResearchContext): Promise<ResearchProposal>;
  review?(context: ResearchContext, proposal: ResearchProposal, changedPaths: string[]): Promise<ProposalReview>;
  reflect?(outcome: ResearchOutcome): Promise<ResearchConclusion>;
  getUsage?(): AgentUsage;
  dispose?(): void | Promise<void>;
}

export type ResearcherFactory = (workspacePath: string, experimentDir: string, profile?: AgentProfileConfig) => Promise<Researcher>;
