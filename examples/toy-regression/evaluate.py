"""Dependency-free, deterministic evaluator for the autoresearch demo."""

from __future__ import annotations

import json
import math
import os
import random
import time
from pathlib import Path

from holdout import target
from model import features, regularization, validate_spec


def solve(matrix: list[list[float]], values: list[float]) -> list[float]:
    augmented = [row[:] + [value] for row, value in zip(matrix, values, strict=True)]
    size = len(values)
    for pivot in range(size):
        best = max(range(pivot, size), key=lambda row: abs(augmented[row][pivot]))
        augmented[pivot], augmented[best] = augmented[best], augmented[pivot]
        scale = augmented[pivot][pivot]
        if abs(scale) < 1e-12:
            raise RuntimeError("Singular normal equation")
        augmented[pivot] = [value / scale for value in augmented[pivot]]
        for row in range(size):
            if row == pivot:
                continue
            factor = augmented[row][pivot]
            augmented[row] = [current - factor * reference for current, reference in zip(augmented[row], augmented[pivot], strict=True)]
    return [row[-1] for row in augmented]


def main() -> None:
    started = time.monotonic()
    seed = int(os.environ["AUTORESEARCH_SEED"])
    stage = os.environ.get("AUTORESEARCH_STAGE", "canonical")
    budget_ratio = float(os.environ.get("AUTORESEARCH_BUDGET_RATIO", "1"))
    if not math.isfinite(budget_ratio) or not 0 < budget_ratio <= 1:
        raise ValueError("AUTORESEARCH_BUDGET_RATIO must be a finite number in (0, 1]")
    spec = json.loads(Path("experiment.json").read_text(encoding="utf-8"))
    validate_spec(spec)
    randomizer = random.Random(seed)
    # Stages spend a smaller or larger fraction of the fixed training budget.
    # The seed and sampling procedure stay identical, so a stage remains
    # reproducible while screening candidates more cheaply than canonical.
    train_examples = max(8, round(80 * budget_ratio))
    train_x = [randomizer.uniform(-1.0, 1.0) for _ in range(train_examples)]
    train_y = [target(x) + randomizer.gauss(0.0, 0.04) for x in train_x]
    feature_rows = [features(x, spec) for x in train_x]
    width = len(feature_rows[0])
    if width == 0 or any(len(row) != width for row in feature_rows):
        raise RuntimeError("Candidate features must have a fixed positive width")
    if any(not math.isfinite(value) for row in feature_rows for value in row):
        raise RuntimeError("Candidate features must be finite")
    gram = [[0.0 for _ in range(width)] for _ in range(width)]
    rhs = [0.0 for _ in range(width)]
    for row, y in zip(feature_rows, train_y, strict=True):
        for left in range(width):
            rhs[left] += row[left] * y
            for right in range(width):
                gram[left][right] += row[left] * row[right]
    for index in range(width):
        gram[index][index] += regularization(index, spec)
    coefficients = solve(gram, rhs)

    validation_x = [-1.0 + index / 100 for index in range(201)]
    errors: list[tuple[float, float]] = []
    for x in validation_x:
        prediction = sum(weight * value for weight, value in zip(coefficients, features(x, spec), strict=True))
        errors.append((x, (prediction - target(x)) ** 2))

    def rmse_for(values: list[tuple[float, float]]) -> float:
        if not values:
            raise RuntimeError("validation slice is empty")
        return math.sqrt(sum(error for _, error in values) / len(values))

    rmse = rmse_for(errors)
    center = [entry for entry in errors if abs(entry[0]) <= 0.5]
    edges = [entry for entry in errors if abs(entry[0]) > 0.5]
    negative = [entry for entry in errors if entry[0] < 0]
    positive = [entry for entry in errors if entry[0] >= 0]

    payload = {
        "metrics": {
            "validation_rmse": rmse,
            "parameter_count": float(width),
            "slice_center_rmse": rmse_for(center),
            "slice_edge_rmse": rmse_for(edges),
            "slice_negative_rmse": rmse_for(negative),
            "slice_positive_rmse": rmse_for(positive),
        },
        "metadata": {
            "seed": seed,
            "stage": stage,
            "budget_ratio": budget_ratio,
            "train_examples": train_examples,
            "validation_examples": len(validation_x),
            "candidate_spec": spec,
            "duration_seconds": time.monotonic() - started,
        },
    }
    metrics_path = Path(os.environ["AUTORESEARCH_METRICS_PATH"])
    metrics_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
