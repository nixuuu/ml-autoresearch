---
name: ml-autoresearch-author-config
description: Create and review version 2 autoresearch.config.json files for ml-autoresearch, including path isolation, agent settings, evaluator runners, metrics, guardrails, and budgets. Use when configuring a new experiment, adapting an existing ML repository, or diagnosing configuration validation errors.
---

# Author an Autoresearch Configuration

Write strict JSON without comments. Resolve `sourceDir` and `outputDir` relative to the configuration file.

## Start from This Shape

```json
{
  "$schema": "/absolute/path/to/autoresearch.schema.json",
  "version": 2,
  "name": "model-experiment",
  "project": {
    "sourceDir": ".",
    "mutablePaths": ["train.py", "model.py"],
    "protectedPaths": ["evaluate.py", "data/splits.json"],
    "hiddenPaths": ["data/holdout-labels.json"],
    "copyIgnore": ["runs", ".git", "__pycache__"]
  },
  "agent": {
    "model": "openai-codex/gpt-5.6-sol",
    "thinkingLevel": "xhigh",
    "analysis": {
      "enabled": true,
      "timeoutSeconds": 300,
      "maxCalls": 30,
      "maxOutputBytes": 262144,
      "inheritEnv": [],
      "env": {},
      "runner": {
        "mode": "docker",
        "image": "my-research-image:latest",
        "network": "none",
        "readOnlyRoot": true,
        "pidsLimit": 256
      }
    }
  },
  "evaluator": {
    "command": ["python3", "evaluate.py"],
    "timeoutSeconds": 900,
    "repetitions": 3,
    "seeds": [17, 29, 43],
    "inheritEnv": ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV", "CUDA_VISIBLE_DEVICES"],
    "env": {},
    "cache": {
      "enabled": true,
      "path": ".autoresearch/cache",
      "namespace": "dataset-v1-evaluator-v1",
      "readOnly": false,
      "results": true
    },
    "agentRequests": {
      "allowPairedComparison": true,
      "maxSeeds": 5
    },
    "runner": { "mode": "local" }
  },
  "metrics": {
    "primary": {
      "name": "validation_loss",
      "direction": "minimize",
      "format": "number",
      "minimumDelta": 0.001,
      "aggregation": "median"
    },
    "guardrails": [
      {
        "name": "latency_ms",
        "direction": "minimize",
        "format": "number",
        "aggregation": "median",
        "maxRegression": 2.0
      }
    ]
  },
  "budget": {
    "maxExperiments": 20,
    "maxWallTimeMinutes": 480,
    "maxConsecutiveFailures": 3
  },
  "learning": {
    "beamWidth": 3,
    "maxFrontierPerCategory": 1,
    "maxBranchDepth": 3,
    "maxTemporaryRegressionRatio": 0.05,
    "recentExperiments": 12,
    "maxContextLessons": 40,
    "supportThreshold": 2,
    "contradictionThreshold": 1,
    "strategy": {
      "explorationRate": 0.25,
      "backtrackRate": 0.1,
      "replicationRate": 0.1,
      "falsificationRate": 0.1
    },
    "humanLessons": []
  },
  "outputDir": "runs",
  "researchInstructions": "Improve validation loss without changing evaluation, data splits, or the training compute budget. Make one coherent change per experiment."
}
```

## Apply These Rules

- Keep `mutablePaths` narrow but large enough for real research. Paths are relative to `sourceDir`; list several files for coupled model/config changes or list a dedicated candidate directory to allow all descendants. A proposal may change several mutable files when they form one coherent hypothesis.
- Keep evaluator code, held-out data, metric computation, and split definitions outside mutable paths and list them in `protectedPaths`. Put secrets, hidden targets, private scoring logic, and holdout labels in `hiddenPaths` so the agent cannot list or read them.
- Add `outputDir` to `copyIgnore` whenever it is inside `sourceDir`, preventing run workspaces from recursively copying prior runs.
- Express `evaluator.command` as an argv array. The harness does not invoke a shell, so do not use pipes, redirects, variable expansion, or a single quoted command string.
- Ensure `seeds.length >= repetitions`. Use fixed seeds and an aggregation suitable for the metric distribution.
- `evaluator.agentRequests.allowPairedComparison` lets the agent preregister a bounded candidate-versus-current-leader comparison on identical fresh seeds. Keep `maxSeeds` small enough for the evaluation budget. The harness rejects duplicate seeds, configured canonical seeds, and requests above the cap.
- `evaluator.cache` is optional. When present and enabled, the harness exposes `<path>/<namespace>` through `AUTORESEARCH_SHARED_CACHE_DIR` and excludes it from copied candidate workspaces. The evaluator may ignore it. Use content-addressed immutable entries for split indices, fixed preprocessing, or embeddings; never share candidate-dependent artifacts without including their code/workspace fingerprint. Set `readOnly: true` for a pre-populated cache. Do not store secrets or holdout labels in a writable cache because candidate code runs inside the evaluator process.
- Use one primary metric with `minimize` or `maximize`. Set `minimumDelta` from measured baseline noise.
- Set each metric's `format` to `number` or `percentage`. Percentage metrics must be emitted as fractions (`0.42` means `42%`); thresholds remain in that raw fractional scale. Formatting changes presentation only. The dashboard shows percentage-metric values in `%`, absolute improvement in percentage points, and relative improvement in `%`.
- Use guardrail `min` or `max` for absolute constraints and `maxRegression` for allowed deterioration from the accepted candidate.
- Set `maxWallTimeMinutes` to `0` only when wall time should be unlimited. `maxExperiments` must remain a positive integer.
- Prefer Docker with `network: "none"`, bounded CPU/memory/PIDs, and a pinned image for autonomous or untrusted evaluation. Supply `image` in Docker mode.
- Put project-specific research boundaries in `researchInstructions`; never instruct the agent to edit or bypass evaluation.
- Keep strategy rates at or below a combined `1`; the remainder is the exploit rate.
- Interpret `maxTemporaryRegressionRatio` relative to the global leader's primary value. It retains a branch but never promotes it.
- Use `maxFrontierPerCategory` to keep semantically equivalent tuning variants from consuming the whole beam.
- Pin `agent.model` with an explicit provider prefix and choose `thinkingLevel` deliberately for the research cost/quality tradeoff. CLI overrides are `--model` and `--thinking-level`/`--reasoning`.
- `agent.analysis` is opt-in and gives the implementer an audited arbitrary-command tool. Prefer a pinned Docker image, `network: "none"`, bounded resources and an empty `inheritEnv`. The Docker runner receives a persistent mirror without `hiddenPaths`; command-side writes remain scratch-only, while final candidate edits still use restricted mutation tools.
- `runtimeDependencies` is optional and requires both analysis and evaluation to use Docker with the same base image. Put its `manifestPath` inside a mutable candidate directory and its `cachePath` in `copyIgnore`. Allowlist registry package names narrowly; use `versions` to force a configured specifier, `python.onlyBinary: true`, `bun.ignoreScripts: true`, and bounded install time/count/bytes. Environment profiles are the only way an agent may switch images or resource envelopes.
- A dependency with `scope=analysis` is disposable and never reaches evaluation. A dependency with `scope=candidate` writes the locked manifest and is mounted from the same content-addressed overlay into later analysis and every evaluator stage. Evaluator code should import the package normally; it must not invoke an installer. A missing or tampered lock is a hard evaluation error.
- Local open research is not a security sandbox and requires `agent.analysis.runner.allowHostExecution: true`. Enable it only when the model and every generated script are trusted with the current OS account.
- For adversarial or competition-like evaluation, run candidate inference separately from trusted scoring. Give the candidate features only, collect predictions, and score them in a process that alone can read holdout labels. `hiddenPaths` protects agent tools and the Docker analysis mirror, not arbitrary candidate code invoked inside the evaluator process.
- Use `humanLessons` only for explicit human knowledge or constraints; agent interpretations belong to the run memory.

## Advanced Research Controls

For open research that may require optional libraries, add a controlled broker:

```json
"runtimeDependencies": {
  "manifestPath": "candidate/autoresearch.dependencies.json",
  "allowedManagers": ["python"],
  "allow": [
    { "manager": "python", "package": "xgboost", "versions": "3.0.4" },
    { "manager": "python", "package": "statsmodels" }
  ],
  "maxDirectDependencies": 4,
  "maxInstallSeconds": 300,
  "maxEnvironmentBytes": 1073741824,
  "cachePath": ".autoresearch/dependencies",
  "python": { "onlyBinary": true },
  "environmentProfiles": {
    "gpu": { "image": "my-research-image:cuda", "gpus": "all", "memory": "24g" }
  }
}
```

Keep registry credentials out of JSON and audit output. Prefer an internal
allowlisted registry or credentials supplied by infrastructure outside the
agent-visible configuration.

Add staged evaluation when a cheap screen can reject a candidate before the
canonical budget:

```json
"evaluator": {
  "stages": [
    { "name": "smoke", "budgetRatio": 0.1, "repetitions": 1, "pruneIfClearlyWorse": true },
    { "name": "screening", "budgetRatio": 0.35, "repetitions": 2, "pruneIfClearlyWorse": true },
    { "name": "canonical", "budgetRatio": 1, "repetitions": 5, "pruneIfClearlyWorse": false }
  ],
  "statistics": {
    "enabled": true,
    "confidenceLevel": 0.95,
    "equivalenceMargin": 0.001,
    "minimumSeeds": 3,
    "maximumSeeds": 15,
    "seedStep": 2
  },
  "repetitionConcurrency": 2
}
```

The evaluator receives `AUTORESEARCH_STAGE` and
`AUTORESEARCH_BUDGET_RATIO`; use them to scale a fixed training/sample budget
while preserving the same split and metric definitions. Adaptive statistics
adds seeds only when the comparison is inconclusive. Keep `maximumSeeds` and
timeouts within the actual compute budget.

For multiple objectives, keep one `metrics.primary`, then add independent
objectives and enable the Pareto frontier:

```json
"metrics": {
  "primary": { "name": "validation_loss", "direction": "minimize", "format": "number", "minimumDelta": 0.001 },
  "objectives": [
    { "name": "latency_ms", "direction": "minimize", "format": "number", "weight": 1 },
    { "name": "slice_edge_recall", "direction": "maximize", "format": "percentage", "weight": 1 }
  ],
  "pareto": { "enabled": true }
}
```

Campaign scheduling, ablations, merge attempts and meta-research are enabled
under `learning.campaign` and `learning.meta`. `search.parameters` declares
safe tunable values (`float`, `integer`, `categorical`, `boolean`) using a
mutable file and dotted JSON path. `execution.experimentConcurrency` controls
independent candidate families. With `execution.asha.agentCandidates`, separate
agents may propose variants from one frozen parent and ASHA advances only the
strongest variants through later evaluator stages. Set concurrency to `1` when
jobs share a non-isolated resource. Prefer structured `resources`; legacy
`resourceSlots` remains available for simple labels.

When several values of one causal parameter should be compared under the same
code, seeds and evaluator, enable `search.sweeps`. This lets the agent request
one `evaluationRequest` with `mode: "parameter_sweep"`; it does not create one
research experiment per value. Every requested parameter must be declared by
name in `search.parameters`, and its file must be mutable JSON.

```json
"learning": {
  "strategy": { "optimizeRate": 0.1, "mergeRate": 0.05, "ablationRate": 0.05 },
  "campaign": {
    "enabled": true,
    "queueRate": 0.35,
    "maxQueued": 40,
    "hypothesesPerProposal": 4,
    "autoAblations": true,
    "maxAblationsPerPromotion": 3,
    "autoMerge": true
  },
  "meta": { "enabled": true, "updateInterval": 5, "warmupExperiments": 5, "explorationFloor": 0.05 },
  "acquisition": { "enabled": true, "minimumObservations": 5, "explorationFloor": 0.1 },
  "ensemble": { "enabled": true, "minimumMembers": 2, "maximumMembers": 4, "interval": 5 },
  "sliceDiscovery": { "enabled": true, "minimumSamples": 30, "maximumTickets": 3, "regressionThreshold": 0.001 }
},
"search": {
  "enabled": true,
  "seed": 2027,
  "exploitationRatio": 0.55,
  "surrogate": { "enabled": true, "minimumObservations": 5, "candidatePoolSize": 64, "explorationWeight": 0.25 },
  "sweeps": { "enabled": true, "maxValues": 5, "maxConcurrentTrials": 2, "reductionFactor": 2 },
  "parameters": [
    { "name": "depth", "file": "experiment.json", "path": "model.depth", "type": "integer", "min": 2, "max": 12 },
    { "name": "dropout", "file": "experiment.json", "path": "model.dropout", "type": "float", "min": 0, "max": 0.5 },
    { "name": "activation", "file": "experiment.json", "path": "model.activation", "type": "categorical", "values": ["relu", "gelu"] },
    { "name": "bias", "file": "experiment.json", "path": "model.bias", "type": "boolean" }
  ]
},
"execution": {
  "experimentConcurrency": 2,
  "resources": [
    { "id": "gpu-0", "cpu": 8, "memoryGb": 32, "gpu": 1, "vramGb": 24, "maxConcurrent": 1 },
    { "id": "gpu-1", "cpu": 8, "memoryGb": 32, "gpu": 1, "vramGb": 24, "maxConcurrent": 1 }
  ],
  "asha": { "enabled": true, "familySize": 2, "reductionFactor": 2, "agentCandidates": true }
},
"knowledge": {
  "enabled": true,
  "path": ".autoresearch/project-knowledge.json",
  "scope": { "dataset": "v3", "evaluator": "v2" },
  "minimumConfidence": 0.7
}
```

`maxConcurrentTrials` must fit the total execution-resource capacity. A larger
`reductionFactor` is more aggressive: after each non-final evaluator stage the
harness advances approximately `ceil(active / reductionFactor)` values. Keep
it at `2` initially. The evaluator contract remains unchanged; the optional
`AUTORESEARCH_SWEEP_PARAMETER`, `AUTORESEARCH_SWEEP_VALUE`, and
`AUTORESEARCH_SWEEP_TRIAL_ID` variables are telemetry only.

Use `agent.pool` for implementer model candidates and `agent.roles` for the optional
implementer/reviewer split. Keep role prompts
focused and preserve the harness as the only authority for metric decisions.

## Validate

Run:

```bash
ml-autoresearch validate path/to/autoresearch.config.json
```

Treat validation as structural and executable availability checking. Also run the evaluator directly with temporary `AUTORESEARCH_METRICS_PATH`, `AUTORESEARCH_ARTIFACT_DIR`, `AUTORESEARCH_SEED`, and `AUTORESEARCH_EXPERIMENT_ID` values before starting the agent loop.
