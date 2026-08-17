"""Baseline candidate. The research agent may replace this entire directory."""

from __future__ import annotations


def fit_predict(train_rows: list[dict[str, float]], test_rows: list[dict[str, float]]) -> list[float]:
    mean_target = sum(row["target"] for row in train_rows) / len(train_rows)
    return [mean_target for _ in test_rows]
