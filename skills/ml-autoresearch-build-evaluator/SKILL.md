---
name: ml-autoresearch-build-evaluator
description: Build or review deterministic evaluator entry points for ml-autoresearch, including fixed seeds, held-out data, finite metric JSON output, artifacts, local or Docker execution, and anti-tampering boundaries. Use when preparing evaluation files for a new scenario or investigating failed and noisy experiment measurements.
---

# Build an ML Evaluator

Make the evaluator an immutable source of truth. Give the baseline and every candidate identical evaluation conditions.

## Runtime Contract

Read these environment variables:

- `AUTORESEARCH_METRICS_PATH`: required destination for the JSON result;
- `AUTORESEARCH_ARTIFACT_DIR`: writable directory for checkpoints and supporting artifacts;
- `AUTORESEARCH_SEED`: fixed seed for the current repetition;
- `AUTORESEARCH_EXPERIMENT_ID`: baseline or candidate identifier for metadata and logs.
- `AUTORESEARCH_STAGE`: configured stage name such as `smoke`, `screening`, or `canonical`;
- `AUTORESEARCH_BUDGET_RATIO`: finite stage budget ratio in `(0, 1]`.
- `AUTORESEARCH_REPETITION`: zero-based repetition index;
- `AUTORESEARCH_PHASE_EVENTS_PATH`: optional JSONL destination for phase telemetry;
- `AUTORESEARCH_CHECKPOINT_MANIFEST_PATH`: optional stage checkpoint manifest destination;
- `AUTORESEARCH_PREVIOUS_STAGE_ARTIFACT_DIR`: optional prior rung artifacts;
- `AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH`: optional prior rung manifest;
- `AUTORESEARCH_SHARED_CACHE_DIR`: optional persistent cache directory, present only when `evaluator.cache` is enabled;
- `AUTORESEARCH_CACHE_NAMESPACE`: configured cache namespace, present together with the shared cache directory.

Exit with code `0` only after atomically or completely writing:

```json
{
  "metrics": {
    "validation_loss": 0.123,
    "latency_ms": 18.4
  },
  "metadata": {
    "split": "validation-v1"
  }
}
```

Metric values must be finite JSON numbers, not strings, `NaN`, or infinity. Metric names must exactly match the configuration.

## Implementation Pattern

Use the project language, but preserve this flow:

```python
import json
import math
import os
import random
from pathlib import Path

seed = int(os.environ["AUTORESEARCH_SEED"])
random.seed(seed)

# Load the candidate from the current working directory.
# Load a fixed held-out split without exposing its targets to mutable code.
# Train/evaluate with a fixed compute budget and calculate metrics.
validation_loss = evaluate_candidate(seed)

if not math.isfinite(validation_loss):
    raise RuntimeError("validation_loss is not finite")

metrics_path = Path(os.environ["AUTORESEARCH_METRICS_PATH"])
metrics_path.parent.mkdir(parents=True, exist_ok=True)
metrics_path.write_text(json.dumps({
    "metrics": {"validation_loss": validation_loss},
    "metadata": {"seed": seed}
}))
```

Adapt `evaluate_candidate`; do not leave placeholder calls in the delivered evaluator.

The shared cache is an optional capability, not a requirement. An evaluator that
does not benefit from caching may ignore both cache variables. When it does use
them, make entries content-addressed and publish them atomically. A split/fold
key should include the dataset fingerprint, split algorithm and version, seed,
fold count, and stratification/group/time rules; it must not include the
experiment id or stage name. Use stable record IDs rather than row positions.
If a cached artifact depends on mutable preprocessing, features, or model code,
include that code or workspace fingerprint in its key.

When exact result caching is enabled, the harness caches only the final-stage
metric payload. Treat the cache namespace as part of the evaluator protocol:
change it whenever external data, dependencies, split semantics, or hidden
scoring code changes. Do not enable exact result reuse for nondeterministic or
externally stateful evaluators.

## Stages, slices, and multiple objectives

Use `AUTORESEARCH_BUDGET_RATIO` to reduce a fixed training/sample budget for
screening stages while keeping the seed, split, preprocessing, and metric
definitions comparable. Record `AUTORESEARCH_STAGE`, the ratio, and the actual
work performed in `metadata`. Never switch to training loss or a different
holdout because the stage is cheap.

If checkpointing is enabled, save enough state to
`AUTORESEARCH_CHECKPOINT_MANIFEST_PATH` to continue exactly from the previous
stage. On later stages, validate and load the prior manifest/artifacts instead
of retraining from zero. Stage budgets are cumulative targets, not extra
independent training budgets.

For phase telemetry, append one JSON object per line to
`AUTORESEARCH_PHASE_EVENTS_PATH` with `timestamp`, `phase`, `status` and, for
completed events, `durationMs`. Recommended phases are `load_data`, `features`,
`train`, `predict`, and `metrics`. The same totals may also be returned as
`metadata.timings`.

If the scenario has known failure modes, emit finite slice metrics alongside
the overall metric, for example `slice_tail_rmse`, `slice_rare_class_recall`,
or `slice_long_sequence_latency_ms`. They can be configured as additional
objectives for Pareto comparisons, while the primary metric remains the main
promotion signal and guardrails remain hard constraints.

For automatic weak-slice discovery, emit structured observations in
`metadata.sliceMetrics`:

```json
[{ "name": "rare-class", "count": 84, "metrics": { "validation_loss": 0.31 } }]
```

Use stable, non-sensitive slice names and real sample counts. Never expose
hidden labels or individual records.

Emit metrics configured with `format: "percentage"` as fractions: use `0.42`
for 42%, not `42`. Keep minimum deltas and guardrail thresholds in the same raw
fractional scale. This lets the dashboard distinguish percentage-point changes
from relative percentage improvements without changing evaluation semantics.

When adaptive statistics are enabled, the harness may invoke more seeds than
the initial repetition count. The evaluator must remain deterministic for each
`AUTORESEARCH_SEED`; do not infer a global run state from repetition number.

## Integrity Rules

- Freeze the validation/test split and preprocessing used for metric computation.
- Seed all relevant RNGs, including framework and accelerator RNGs where supported.
- Hold dataset, epochs/steps, hardware allocation, timeout, and early-stopping rules constant across candidates.
- Prevent mutable model code from receiving held-out labels or defining the final metric.
- Put evaluator and split files in `protectedPaths`, never in `mutablePaths`. Put hidden labels, target functions, and private scoring logic in `hiddenPaths`; a protected path is immutable but otherwise readable by the agent.
- Write experiment-specific checkpoints and temporary files below `AUTORESEARCH_ARTIFACT_DIR`; a Docker workspace can be read-only. Use `AUTORESEARCH_SHARED_CACHE_DIR` only for deterministic entries intentionally shared across evaluations.
- Keep validation/test membership identical across stages. If a lower budget samples training rows, derive one deterministic order per split and use nested prefixes so `smoke` is a subset of `screening`, which is a subset of `canonical`.
- Coordinate parallel cache misses with a per-key lock, write into a temporary sibling directory, validate the manifest and hashes, then atomically rename it into place. Never consume partial entries.
- Never put secrets, private holdout labels, or scoring-only targets in a writable shared cache. Candidate code executes inside the evaluator process and can access the cache mount. Prefer `readOnly: true` for pre-populated sensitive, candidate-independent data.
- When `agent.analysis` is enabled, treat its results as exploratory evidence only. Do not accept metrics produced by analysis scripts; the protected evaluator must recompute every promotion metric independently.
- If candidate code is potentially adversarial, do not import it into the trusted scoring process. Execute inference in a sandbox that receives feature rows without targets, persist only predictions, then score them in a separate process with exclusive access to holdout labels.
- Do not silently fall back to training metrics or stale metrics files after an error.
- Emit useful diagnostics to stdout/stderr and fail non-zero on missing data, invalid output, or unavailable dependencies.
- Measure guardrails in the same controlled way as the primary metric.
- Keep stage outputs schema-compatible: every stage must emit the metrics needed
  by primary, guardrail, and objective definitions, even when its budget is
  smaller.

## Verify Before Agent Use

Run the evaluator at least twice with the same seed and compare results. Run the configured seed set to estimate noise. Confirm that the metrics file is freshly created, parses as JSON, contains every configured metric, and changes to protected evaluation files are unnecessary for model experiments.

If `evaluator.agentRequests.allowPairedComparison` is enabled, the same evaluator will also be invoked for the current leader and candidate on agent-preregistered fresh seeds. Do not branch behavior on the experiment ID; paired comparability depends on identical evaluation logic. Size timeouts and compute budgets for the extra two evaluations per requested seed.

If `search.sweeps.enabled` is enabled, the harness may invoke this same
evaluator for several isolated workspaces inside one logical experiment. Do not
special-case their score or alter the metric schema. Every trial receives the
same canonical seeds and stages; only one declared JSON parameter differs.
Optional telemetry identifies the trial through `AUTORESEARCH_SWEEP_PARAMETER`,
`AUTORESEARCH_SWEEP_VALUE`, and `AUTORESEARCH_SWEEP_TRIAL_ID`. The evaluator may
ignore all three. Make cheap stages genuinely cheaper so inter-trial pruning
can save work, and keep rankings directionally representative of canonical.

For staged evaluation, test each configured stage directly by setting
`AUTORESEARCH_STAGE` and `AUTORESEARCH_BUDGET_RATIO` in the environment. Verify
that screening is cheaper, canonical remains the reference measurement, and
slice metrics do not disappear at a lower ratio.

When shared caching is enabled, verify one cold and one warm invocation with the
same dataset/split key, then change the dataset or split protocol and confirm a
cache miss. Run two concurrent cold invocations to verify locking and atomic
publication. Record cache key, hit/miss, preparation time, and an estimated
saved duration in evaluator metadata when practical.
