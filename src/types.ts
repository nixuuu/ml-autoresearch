export type Direction = "minimize" | "maximize";
export type Aggregation = "mean" | "median" | "min" | "max";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ResearchStrategy = "exploit" | "explore" | "backtrack" | "replicate" | "falsify";
export type ResearchDecisionStatus = "promote" | "retain" | "discard" | "failure";
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
  minimumDelta: number;
  aggregation: Aggregation;
}

export interface GuardrailMetricConfig {
  name: string;
  direction: Direction;
  aggregation: Aggregation;
  maxRegression?: number;
  min?: number;
  max?: number;
}

export interface HarnessConfig {
  version: 1;
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
  };
  evaluator: {
    command: string[];
    timeoutSeconds: number;
    repetitions: number;
    seeds: number[];
    inheritEnv: string[];
    env: Record<string, string>;
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
    };
    humanLessons: Array<{
      id: string;
      claim: string;
      guidance: LessonGuidance;
    }>;
  };
  outputDir: string;
  researchInstructions: string;
}

export interface PairedEvaluationRequest {
  mode: "paired";
  seeds: number[];
  rationale: string;
}

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
}

export interface EvaluationResult {
  ok: boolean;
  attempts: EvaluationAttempt[];
  aggregatedMetrics: Record<string, number>;
  error?: string;
  skipped?: boolean;
}

export interface DecisionResult {
  status: ResearchDecisionStatus | "keep" | "reject";
  primaryDelta: number | null;
  reasons: string[];
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
  evaluationRequest?: PairedEvaluationRequest;
}

export interface PairedEvaluationResult {
  referenceId: string;
  seeds: number[];
  rationale: string;
  reference: EvaluationResult;
  candidate: EvaluationResult;
  decision: DecisionResult;
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
  schemaVersion: 2;
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
}

export interface ResearchGraph {
  schemaVersion: 1 | 2;
  leaderId: string;
  frontierIds: string[];
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
  decision: DecisionResult;
}

export interface RunState {
  schemaVersion: 1 | 2 | 3;
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  configPath: string;
  runDir: string;
  sourceDir: string;
  agent?: {
    model?: string;
    thinkingLevel: ThinkingLevel;
  };
  primaryMetric?: PrimaryMetricConfig;
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
  experiments: ExperimentRecord[];
  stopReason?: string;
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
}

export interface ResearchProposal {
  narrative: string;
  plan?: ExperimentPlan;
  agent?: {
    model?: string;
    thinkingLevel: ThinkingLevel;
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
  decision: DecisionResult;
}

export interface Researcher {
  propose(context: ResearchContext): Promise<ResearchProposal>;
  reflect?(outcome: ResearchOutcome): Promise<ResearchConclusion>;
  dispose?(): void | Promise<void>;
}

export type ResearcherFactory = (workspacePath: string, experimentDir: string) => Promise<Researcher>;
