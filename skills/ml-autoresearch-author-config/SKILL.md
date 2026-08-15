---
name: ml-autoresearch-author-config
description: Create and review version 1 autoresearch.config.json files for ml-autoresearch, including path isolation, agent settings, evaluator runners, metrics, guardrails, and budgets. Use when configuring a new experiment, adapting an existing ML repository, or diagnosing configuration validation errors.
---

# Author an Autoresearch Configuration

Write strict JSON without comments. Resolve `sourceDir` and `outputDir` relative to the configuration file.

## Start from This Shape

```json
{
  "$schema": "/absolute/path/to/autoresearch.schema.json",
  "version": 1,
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
    "thinkingLevel": "xhigh"
  },
  "evaluator": {
    "command": ["python3", "evaluate.py"],
    "timeoutSeconds": 900,
    "repetitions": 3,
    "seeds": [17, 29, 43],
    "inheritEnv": ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV", "CUDA_VISIBLE_DEVICES"],
    "env": {},
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
      "minimumDelta": 0.001,
      "aggregation": "median"
    },
    "guardrails": [
      {
        "name": "latency_ms",
        "direction": "minimize",
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
- Use one primary metric with `minimize` or `maximize`. Set `minimumDelta` from measured baseline noise.
- Use guardrail `min` or `max` for absolute constraints and `maxRegression` for allowed deterioration from the accepted candidate.
- Set `maxWallTimeMinutes` to `0` only when wall time should be unlimited. `maxExperiments` must remain a positive integer.
- Prefer Docker with `network: "none"`, bounded CPU/memory/PIDs, and a pinned image for autonomous or untrusted evaluation. Supply `image` in Docker mode.
- Put project-specific research boundaries in `researchInstructions`; never instruct the agent to edit or bypass evaluation.
- Keep strategy rates at or below a combined `1`; the remainder is the exploit rate.
- Interpret `maxTemporaryRegressionRatio` relative to the global leader's primary value. It retains a branch but never promotes it.
- Use `maxFrontierPerCategory` to keep semantically equivalent tuning variants from consuming the whole beam.
- Pin `agent.model` with an explicit provider prefix and choose `thinkingLevel` deliberately for the research cost/quality tradeoff. CLI overrides are `--model` and `--thinking-level`/`--reasoning`.
- Use `humanLessons` only for explicit human knowledge or constraints; agent interpretations belong to the run memory.

## Validate

Run:

```bash
ml-autoresearch validate path/to/autoresearch.config.json
```

Treat validation as structural and executable availability checking. Also run the evaluator directly with temporary `AUTORESEARCH_METRICS_PATH`, `AUTORESEARCH_ARTIFACT_DIR`, `AUTORESEARCH_SEED`, and `AUTORESEARCH_EXPERIMENT_ID` values before starting the agent loop.
