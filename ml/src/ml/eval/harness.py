"""Running a scorer across the splits and collecting the numbers.

Thin on purpose. The judgement calls live in `metrics.py` (which metric leads
and why) and in `splits.py` (what a valid split is); this module only makes
sure every scorer is measured the same way on the same rows.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np

from ml.eval.metrics import evaluate_scores
from ml.features.writer import FeatureMatrix

__all__ = ["SPLITS", "evaluate_across_splits", "round_floats", "split_sizes"]

SPLITS: tuple[str, ...] = ("train", "val", "test")


def split_sizes(matrix: FeatureMatrix) -> dict[str, dict[str, Any]]:
    """Row counts, positives and distinct listings per split.

    Distinct listings is reported alongside row count because they are very
    different numbers — a listing contributes one row per hour it stays open —
    and quoting 438k "examples" without saying they come from 113k listings
    would overstate how much independent information is present.
    """
    out: dict[str, dict[str, Any]] = {}
    for split in SPLITS:
        mask = matrix.mask(split)
        labels = matrix.label[mask]
        out[split] = {
            "rows": int(mask.sum()),
            "listings": int(np.unique(matrix.listing_id[mask]).size),
            "positives": int(labels.sum()),
            "base_rate": float(labels.mean()) if labels.size else 0.0,
        }
    return out


def evaluate_across_splits(
    matrix: FeatureMatrix,
    score_fn: Callable[[FeatureMatrix, str], np.ndarray],
    recall_target: float,
) -> dict[str, dict[str, Any]]:
    return {
        split: evaluate_scores(matrix.labels(split), score_fn(matrix, split), recall_target)
        for split in SPLITS
    }


def round_floats(value: Any, places: int = 6) -> Any:
    """Round every float in a nested structure.

    `baselines.json` is committed and diffed. Without this, a rerun on a
    different BLAS build shifts the sixteenth decimal place of an AUC and the
    file shows as changed when nothing about the result did.
    """
    if isinstance(value, float):
        return round(value, places)
    if isinstance(value, dict):
        return {key: round_floats(item, places) for key, item in value.items()}
    if isinstance(value, list):
        return [round_floats(item, places) for item in value]
    return value
