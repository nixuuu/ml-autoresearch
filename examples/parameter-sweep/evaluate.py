"""Small deterministic evaluator demonstrating a staged parameter sweep."""

from __future__ import annotations

import json
import math
import os
import random
from pathlib import Path


spec = json.loads(Path("experiment.json").read_text(encoding="utf-8"))
learning_rate = float(spec["optimizer"]["learning_rate"])
hidden_width = int(spec["model"]["hidden_width"])
seed = int(os.environ["AUTORESEARCH_SEED"])
budget_ratio = float(os.environ["AUTORESEARCH_BUDGET_RATIO"])

# The optimum is deliberately near 0.03. A small seeded measurement term makes
# the final three-seed stage more trustworthy than the cheap screening stage.
rng = random.Random(seed)
distance = abs(math.log10(learning_rate) - math.log10(0.03))
measurement_noise = rng.uniform(-0.002, 0.002) * (1.2 - 0.2 * budget_ratio)
validation_loss = 0.12 + 0.18 * distance + measurement_noise

payload = {
    "metrics": {
        "validation_loss": validation_loss,
        "parameter_count": hidden_width * hidden_width + hidden_width,
    },
    "metadata": {
        "learning_rate": learning_rate,
        "budget_ratio": budget_ratio,
        "sweep_trial": os.environ.get("AUTORESEARCH_SWEEP_TRIAL_ID"),
    },
}
Path(os.environ["AUTORESEARCH_METRICS_PATH"]).write_text(
    json.dumps(payload), encoding="utf-8"
)
