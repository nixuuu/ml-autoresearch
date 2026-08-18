"""Dependency-free, deterministic evaluator for the autoresearch demo."""

from __future__ import annotations

import json
import hashlib
import math
import os
import random
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from holdout import target
from model import features, regularization, validate_spec


PHASE_EVENTS_PATH = os.environ.get("AUTORESEARCH_PHASE_EVENTS_PATH")


def emit_phase(phase: str, status: str, **fields: object) -> None:
    if not PHASE_EVENTS_PATH:
        return
    event = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": phase,
        "status": status,
        **fields,
    }
    with Path(PHASE_EVENTS_PATH).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")


@contextmanager
def measured_phase(name: str, timings: dict[str, float]) -> Iterator[None]:
    started = time.monotonic()
    emit_phase(name, "started")
    try:
        yield
    except Exception:
        emit_phase(name, "failed", durationMs=round((time.monotonic() - started) * 1000, 3))
        raise
    duration_ms = (time.monotonic() - started) * 1000
    timings[name] = duration_ms
    emit_phase(name, "completed", durationMs=round(duration_ms, 3))


def empty_normal_equation(width: int) -> tuple[list[list[float]], list[float]]:
    return [[0.0 for _ in range(width)] for _ in range(width)], [0.0 for _ in range(width)]


def load_previous_checkpoint(seed: int, spec: dict[str, object], width: int, train_examples: int) -> tuple[list[list[float]], list[float], int]:
    checkpoint_path = os.environ.get("AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH")
    if not checkpoint_path or not Path(checkpoint_path).is_file():
        gram, rhs = empty_normal_equation(width)
        return gram, rhs, 0
    checkpoint = json.loads(Path(checkpoint_path).read_text(encoding="utf-8"))
    if checkpoint.get("schema_version") != 1:
        raise RuntimeError("Unsupported previous checkpoint schema")
    if checkpoint.get("seed") != seed or checkpoint.get("candidate_spec") != spec:
        raise RuntimeError("Previous checkpoint does not match the seed and candidate")
    if checkpoint.get("feature_width") != width:
        raise RuntimeError("Previous checkpoint feature width does not match the candidate")
    completed = checkpoint.get("train_examples")
    if not isinstance(completed, int) or completed < 0 or completed > train_examples:
        raise RuntimeError("Previous checkpoint has an invalid training prefix")
    gram = checkpoint.get("gram")
    rhs = checkpoint.get("rhs")
    if (
        not isinstance(gram, list)
        or len(gram) != width
        or any(not isinstance(row, list) or len(row) != width for row in gram)
        or not isinstance(rhs, list)
        or len(rhs) != width
    ):
        raise RuntimeError("Previous checkpoint normal equation has an invalid shape")
    values = [value for row in gram for value in row] + rhs
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        raise RuntimeError("Previous checkpoint contains non-finite values")
    return [[float(value) for value in row] for row in gram], [float(value) for value in rhs], completed


def save_checkpoint(seed: int, spec: dict[str, object], width: int, train_examples: int, gram: list[list[float]], rhs: list[float]) -> None:
    checkpoint_path = os.environ.get("AUTORESEARCH_CHECKPOINT_MANIFEST_PATH")
    if not checkpoint_path:
        return
    payload = {
        "schema_version": 1,
        "seed": seed,
        "candidate_spec": spec,
        "feature_width": width,
        "train_examples": train_examples,
        "gram": gram,
        "rhs": rhs,
    }
    Path(checkpoint_path).write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


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
    timings: dict[str, float] = {}
    seed = int(os.environ["AUTORESEARCH_SEED"])
    stage = os.environ.get("AUTORESEARCH_STAGE", "canonical")
    budget_ratio = float(os.environ.get("AUTORESEARCH_BUDGET_RATIO", "1"))
    if not math.isfinite(budget_ratio) or not 0 < budget_ratio <= 1:
        raise ValueError("AUTORESEARCH_BUDGET_RATIO must be a finite number in (0, 1]")
    with measured_phase("data", timings):
        spec = json.loads(Path("experiment.json").read_text(encoding="utf-8"))
        validate_spec(spec)
        # X and noise use independent generators, making every lower-budget
        # dataset an exact prefix of the canonical dataset for the same seed.
        x_randomizer = random.Random(seed)
        noise_randomizer = random.Random(seed ^ 0x5DEECE66D)
        train_examples = max(8, round(80 * budget_ratio))
        train_x = [x_randomizer.uniform(-1.0, 1.0) for _ in range(train_examples)]
        train_y = [target(x) + noise_randomizer.gauss(0.0, 0.04) for x in train_x]

    with measured_phase("features", timings):
        probe = features(train_x[0], spec)
        width = len(probe)
        if width == 0:
            raise RuntimeError("Candidate features must have a fixed positive width")
        gram, rhs, completed_examples = load_previous_checkpoint(seed, spec, width, train_examples)
        feature_rows = [features(x, spec) for x in train_x[completed_examples:]]
        if any(len(row) != width for row in feature_rows):
            raise RuntimeError("Candidate features must have a fixed positive width")
        if any(not math.isfinite(value) for row in feature_rows for value in row):
            raise RuntimeError("Candidate features must be finite")

    with measured_phase("training", timings):
        for row, y in zip(feature_rows, train_y[completed_examples:], strict=True):
            for left in range(width):
                rhs[left] += row[left] * y
                for right in range(width):
                    gram[left][right] += row[left] * row[right]
        fit_gram = [row[:] for row in gram]
        for index in range(width):
            fit_gram[index][index] += regularization(index, spec)
        coefficients = solve(fit_gram, rhs)
        save_checkpoint(seed, spec, width, train_examples, gram, rhs)

    with measured_phase("validation", timings):
        validation_x = [-1.0 + index / 100 for index in range(201)]
        errors: list[tuple[float, float]] = []
        predictions: list[float] = []
        for x in validation_x:
            prediction = sum(weight * value for weight, value in zip(coefficients, features(x, spec), strict=True))
            predictions.append(prediction)
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
    slice_values = {
        "center": (center, "slice_center_rmse"),
        "edge": (edges, "slice_edge_rmse"),
        "negative": (negative, "slice_negative_rmse"),
        "positive": (positive, "slice_positive_rmse"),
    }
    slice_metrics = [
        {"name": name, "count": len(values), "metrics": {metric_name: rmse_for(values), "validation_rmse": rmse_for(values)}}
        for name, (values, metric_name) in slice_values.items()
    ]

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
            "prediction_sha256": hashlib.sha256(json.dumps(predictions, separators=(",", ":")).encode("utf-8")).hexdigest(),
            "candidate_capabilities": ["toy-polynomial-spec-v1"],
            "consumed_search_parameters": [
                "experiment.json:polynomial_degree",
                "experiment.json:l2_regularization",
                "experiment.json:feature_basis",
                "experiment.json:input_scale",
                "experiment.json:regularize_intercept",
            ],
            "seed": seed,
            "stage": stage,
            "budget_ratio": budget_ratio,
            "train_examples": train_examples,
            "validation_examples": len(validation_x),
            "candidate_spec": spec,
            "duration_seconds": time.monotonic() - started,
            "checkpoint_resumed_examples": completed_examples,
            "timings": {name: round(duration_ms, 3) for name, duration_ms in timings.items()},
            "sliceMetrics": slice_metrics,
        },
    }
    with measured_phase("persist", timings):
        payload["metadata"]["timings"] = {name: round(duration_ms, 3) for name, duration_ms in timings.items()}
        metrics_path = Path(os.environ["AUTORESEARCH_METRICS_PATH"])
        metrics_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
