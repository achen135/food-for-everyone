"""Per-feature attribution — SHAP, without the `shap` package.

## Why there is no `shap` dependency

`docs/ML Subsystem.md` §5 asks for a SHAP summary, and the M13 brief warns that
`shap` pulls in `numba` and `llvmlite` — the pair most likely to break the `ml`
CI job or the Docker build.

It turns out not to be a trade at all. `shap.TreeExplainer` on a LightGBM model
does not implement TreeSHAP itself; it calls into LightGBM, which computes exact
TreeSHAP values in its own C++. `Booster.predict(pred_contrib=True)` reaches the
same code directly. So this is **not a documented substitute for SHAP** in the
sense the brief allowed for — it is SHAP, from the same implementation, minus a
dependency tree that exists to wrap it.

The guarantee that makes TreeSHAP values worth reading is additivity: for every
row, the contributions plus the base value equal the model's raw output.
`verify_additivity` checks exactly that against `predict(raw_score=True)`, and
`ml/tests/test_model.py` asserts it. That check is also what would catch these
being something other than what they claim to be.

## Reading them

Contributions are in **raw score (log-odds) space**, not probability, and they
are computed on the uncalibrated booster — calibration is a monotone map applied
afterwards and reorders nothing, so attribution is unaffected by it.

`mean(|contribution|)` per feature is the standard summary: how much this
feature moves predictions on average, in either direction. It is a statement
about *magnitude*, not direction or correctness — a feature at the top is one
the model relies on, which is the leakage question, not one that is right.
"""

from __future__ import annotations

from typing import Any, Final

import lightgbm as lgb
import numpy as np

__all__ = ["SHAP_SAMPLE_ROWS", "shap_summary", "verify_additivity"]

#: Rows sampled for the summary. TreeSHAP is far more expensive than a
#: prediction, and a mean over tens of thousands of rows is already stable to
#: more decimal places than the card reports.
SHAP_SAMPLE_ROWS: Final[int] = 20_000


def _sample(x: np.ndarray, limit: int) -> np.ndarray:
    """An evenly strided sample.

    Strided rather than randomly drawn: no seed to record, and because the rows
    arrive ordered by `as_of`, a stride covers the whole time span evenly where
    a random draw would only do so on average.
    """
    if x.shape[0] <= limit:
        return x
    stride = x.shape[0] // limit
    return np.asarray(x[::stride][:limit])


def verify_additivity(
    booster: lgb.Booster, x: np.ndarray, num_iteration: int, tolerance: float = 1e-6
) -> float:
    """Max absolute gap between summed contributions and the raw prediction."""
    contributions = np.asarray(
        booster.predict(x, num_iteration=num_iteration, pred_contrib=True), dtype=np.float64
    )
    raw = np.asarray(
        booster.predict(x, num_iteration=num_iteration, raw_score=True), dtype=np.float64
    )
    gap = float(np.max(np.abs(contributions.sum(axis=1) - raw)))
    if gap > tolerance:
        raise ValueError(
            f"TreeSHAP contributions do not sum to the raw prediction (max gap {gap:.3g}); "
            "they are not the attribution they claim to be"
        )
    return gap


def shap_summary(
    booster: lgb.Booster,
    x: np.ndarray,
    feature_names: list[str],
    num_iteration: int,
    split_name: str,
    limit: int = SHAP_SAMPLE_ROWS,
) -> dict[str, Any]:
    """`mean(|SHAP|)` per feature, most-relied-on first."""
    sample = _sample(x, limit)
    additivity_gap = verify_additivity(booster, sample, num_iteration)

    contributions = np.asarray(
        booster.predict(sample, num_iteration=num_iteration, pred_contrib=True), dtype=np.float64
    )
    # The final column is the base value (the model's expected raw output), not
    # a feature.
    per_feature = contributions[:, :-1]
    mean_abs = np.abs(per_feature).mean(axis=0)
    total = float(mean_abs.sum())

    ranked: list[dict[str, Any]] = [
        {
            "feature": name,
            "mean_abs_shap": float(value),
            "share": float(value / total) if total else 0.0,
            "mean_shap": float(per_feature[:, position].mean()),
        }
        for position, (name, value) in enumerate(zip(feature_names, mean_abs, strict=True))
    ]
    # Magnitude descending, then by name, so ties order the same way everywhere.
    ranked.sort(key=lambda entry: (-entry["mean_abs_shap"], entry["feature"]))

    return {
        "method": "TreeSHAP via LightGBM Booster.predict(pred_contrib=True)",
        "units": "raw score (log-odds), uncalibrated booster",
        "computed_on": split_name,
        "rows_sampled": int(sample.shape[0]),
        "sampling": "even stride over rows ordered by as_of",
        "base_value": float(contributions[:, -1].mean()),
        "additivity_max_gap": additivity_gap,
        "features": ranked,
    }
