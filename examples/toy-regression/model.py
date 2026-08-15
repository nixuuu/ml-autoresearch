"""Mutable feature and regularization logic for the demo candidate."""

from __future__ import annotations

import math
from typing import Any


def validate_spec(spec: dict[str, Any]) -> None:
    degree = spec.get("polynomial_degree")
    l2 = spec.get("l2_regularization")
    basis = spec.get("feature_basis")
    scale = spec.get("input_scale")
    if not isinstance(degree, int) or not 0 <= degree <= 12:
        raise ValueError("polynomial_degree must be an integer from 0 to 12")
    if not isinstance(l2, (int, float)) or not math.isfinite(l2) or l2 < 0:
        raise ValueError("l2_regularization must be a finite non-negative number")
    if basis not in {"power", "chebyshev", "legendre"}:
        raise ValueError("feature_basis must be power, chebyshev, or legendre")
    if not isinstance(scale, (int, float)) or not math.isfinite(scale) or scale <= 0:
        raise ValueError("input_scale must be a finite positive number")
    if not isinstance(spec.get("regularize_intercept"), bool):
        raise ValueError("regularize_intercept must be a boolean")


def features(x: float, spec: dict[str, Any]) -> list[float]:
    """Build a fixed-width feature row; agents may extend this implementation."""
    degree = int(spec["polynomial_degree"])
    scaled = x * float(spec["input_scale"])
    basis = spec["feature_basis"]
    if basis == "power":
        return [scaled**power for power in range(degree + 1)]

    values = [1.0]
    if degree == 0:
        return values
    values.append(scaled)
    for order in range(2, degree + 1):
        if basis == "chebyshev":
            values.append(2.0 * scaled * values[-1] - values[-2])
        else:
            values.append(((2 * order - 1) * scaled * values[-1] - (order - 1) * values[-2]) / order)
    return values


def regularization(index: int, spec: dict[str, Any]) -> float:
    if index == 0 and not spec["regularize_intercept"]:
        return 0.0
    return float(spec["l2_regularization"])
