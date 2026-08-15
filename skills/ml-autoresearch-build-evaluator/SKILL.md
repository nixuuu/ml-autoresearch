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

## Integrity Rules

- Freeze the validation/test split and preprocessing used for metric computation.
- Seed all relevant RNGs, including framework and accelerator RNGs where supported.
- Hold dataset, epochs/steps, hardware allocation, timeout, and early-stopping rules constant across candidates.
- Prevent mutable model code from receiving held-out labels or defining the final metric.
- Put evaluator and split files in `protectedPaths`, never in `mutablePaths`. Put hidden labels, target functions, and private scoring logic in `hiddenPaths`; a protected path is immutable but otherwise readable by the agent.
- Write caches, checkpoints, and temporary files below `AUTORESEARCH_ARTIFACT_DIR`; a Docker workspace can be read-only.
- Do not silently fall back to training metrics or stale metrics files after an error.
- Emit useful diagnostics to stdout/stderr and fail non-zero on missing data, invalid output, or unavailable dependencies.
- Measure guardrails in the same controlled way as the primary metric.

## Verify Before Agent Use

Run the evaluator at least twice with the same seed and compare results. Run the configured seed set to estimate noise. Confirm that the metrics file is freshly created, parses as JSON, contains every configured metric, and changes to protected evaluation files are unnecessary for model experiments.

If `evaluator.agentRequests.allowPairedComparison` is enabled, the same evaluator will also be invoked for the current leader and candidate on agent-preregistered fresh seeds. Do not branch behavior on the experiment ID; paired comparability depends on identical evaluation logic. Size timeouts and compute budgets for the extra two evaluations per requested seed.
