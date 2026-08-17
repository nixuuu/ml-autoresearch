"""Protected evaluator for the open-research example."""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import os
import time
from pathlib import Path


def rows(path: str) -> list[dict[str, float]]:
    with Path(path).open(newline="", encoding="utf-8") as handle:
        return [{key: float(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def load_candidate():
    module_path = Path("candidate/solution.py")
    spec = importlib.util.spec_from_file_location("candidate_solution", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load candidate/solution.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


train = rows("data/train.csv")
holdout = rows("data/holdout.csv")
test_features = [{key: value for key, value in row.items() if key != "target"} for row in holdout]
started = time.perf_counter()
predictions = load_candidate().fit_predict(train, test_features)
latency_ms = (time.perf_counter() - started) * 1_000

if len(predictions) != len(holdout):
    raise ValueError(f"Expected {len(holdout)} predictions, got {len(predictions)}")
if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in predictions):
    raise ValueError("Every prediction must be a finite number")

rmse = math.sqrt(sum((float(prediction) - row["target"]) ** 2 for prediction, row in zip(predictions, holdout)) / len(holdout))
candidate_bytes = sum(file.stat().st_size for file in Path("candidate").rglob("*") if file.is_file())
payload = {
    "metrics": {
        "holdout_rmse": rmse,
        "prediction_latency_ms": latency_ms,
        "candidate_bytes": candidate_bytes,
    },
    "metadata": {
        "stage": os.environ["AUTORESEARCH_STAGE"],
        "budget_ratio": float(os.environ["AUTORESEARCH_BUDGET_RATIO"]),
        "holdout_rows": len(holdout),
    },
}
Path(os.environ["AUTORESEARCH_METRICS_PATH"]).write_text(json.dumps(payload), encoding="utf-8")
