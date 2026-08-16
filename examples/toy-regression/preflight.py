"""Fast contract and dependency check for the toy evaluator."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

from holdout import target
from model import features, regularization, validate_spec


def main() -> None:
    spec = json.loads(Path("experiment.json").read_text(encoding="utf-8"))
    validate_spec(spec)
    sample = features(0.25, spec)
    if not sample or any(not math.isfinite(value) for value in sample):
        raise RuntimeError("Candidate features must be finite and non-empty")
    if any(not math.isfinite(regularization(index, spec)) for index in range(len(sample))):
        raise RuntimeError("Candidate regularization must be finite")
    if not math.isfinite(target(0.25)):
        raise RuntimeError("Holdout target must be finite")

    artifact_dir = Path(os.environ["AUTORESEARCH_ARTIFACT_DIR"])
    if not artifact_dir.is_dir():
        raise RuntimeError("AUTORESEARCH_ARTIFACT_DIR must exist")
    print(json.dumps({"ok": True, "feature_width": len(sample)}))


if __name__ == "__main__":
    main()
