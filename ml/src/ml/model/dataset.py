"""The design matrix, and how `val` is divided.

## Which features the model gets, and the one that was dropped

Everything in `FEATURE_NAMES` except `food_category`.

That exclusion is a measured decision, not an oversight. Encoded as a native
LightGBM categorical it is worth **+0.0013 val PR-AUC** (0.9749 -> 0.9762) —
about a tenth of a percent. Against that, `ml/src/ml/features/text.py` says
plainly that the feature is *more* informative on this corpus than it could be
in production: the simulator draws titles from a fixed table of four strings per
category, so the keyword rules recover the generator's own label almost
perfectly, where real donor-written titles would be far noisier.

So the trade is a tenth of a percent of PR-AUC against a model that leans on the
one feature known not to transfer. It is dropped, and `load_matrix`'s existing
default — which already excludes it — is left alone rather than worked around.

## Why `val` is cut in two

`calibrate` fits the probability scale and `calibrate` also has to place a
threshold on it. Doing both on the same rows makes the reported precision at the
target recall a description of the calibration set. `bisect_by_time` cuts `val`
into an earlier `fit` half and a later `op` half; the reasoning for cutting by
time rather than at random is in `ml/src/ml/eval/splits.py`.

`fit` selects hyperparameters *and* fits the calibrator. Those two share a slice,
which is worth stating: the calibrator is fitted on rows the hyperparameter
search already optimised against, so calibration measured on `fit` would be
optimistic. It is not measured there — the Brier score and reliability curve
that the model card reports come from `test`, which nothing selected on.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

import numpy as np

from ml.eval.splits import VAL_FIT_FRACTION, bisect_by_time
from ml.features.writer import FeatureMatrix

__all__ = ["EXCLUDED_FEATURES", "ModelDataset", "build_dataset"]

#: Excluded from the model, with reasoning in this module's docstring.
EXCLUDED_FEATURES: Final[tuple[str, ...]] = ("food_category",)


@dataclass(frozen=True, slots=True)
class ModelDataset:
    """Design matrix, labels and every mask the model half needs."""

    feature_names: list[str]
    x: np.ndarray
    y: np.ndarray
    matrix: FeatureMatrix
    #: `val` rows that select hyperparameters and fit the calibrator.
    val_fit: np.ndarray
    #: `val` rows that place the operating threshold and the tier boundary.
    val_op: np.ndarray
    #: Epoch seconds where `val` was cut, and how many listings straddled it.
    val_boundary: float
    val_purged: int

    def slice(self, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return self.x[mask], self.y[mask]

    def split_mask(self, split: str) -> np.ndarray:
        return self.matrix.mask(split)

    def describe(self) -> dict[str, Any]:
        return {
            "feature_names": list(self.feature_names),
            "n_features": len(self.feature_names),
            "excluded_features": list(EXCLUDED_FEATURES),
            "val_fit_fraction": VAL_FIT_FRACTION,
            "val_boundary": datetime.fromtimestamp(self.val_boundary, tz=UTC).isoformat(),
            "val_listings_purged_at_boundary": self.val_purged,
            "val_fit_rows": int(self.val_fit.sum()),
            "val_op_rows": int(self.val_op.sum()),
            "val_fit_base_rate": float(self.y[self.val_fit].mean()),
            "val_op_base_rate": float(self.y[self.val_op].mean()),
        }


def build_dataset(matrix: FeatureMatrix) -> ModelDataset:
    """Stack the numeric columns and divide `val` by time."""
    names = [name for name in matrix.columns if name not in EXCLUDED_FEATURES]
    x = np.column_stack([matrix.columns[name] for name in names])
    y = matrix.label.astype(np.int32)

    in_val = matrix.mask("val")
    listing_ids = matrix.listing_id[in_val]
    times = matrix.as_of[in_val]

    # First and last observation time per listing, so a listing whose
    # observations straddle the cut can be dropped rather than split.
    spans: dict[str, tuple[float, float]] = {}
    for listing_id, when in zip(listing_ids, times, strict=True):
        span = spans.get(listing_id)
        if span is None:
            spans[listing_id] = (when, when)
        else:
            spans[listing_id] = (min(span[0], when), max(span[1], when))

    assignment, boundary, purged = bisect_by_time(spans)

    val_fit = np.zeros(len(matrix), dtype=bool)
    val_op = np.zeros(len(matrix), dtype=bool)
    val_positions = np.flatnonzero(in_val)
    for position, listing_id in zip(val_positions, listing_ids, strict=True):
        side = assignment.get(listing_id)
        if side == "fit":
            val_fit[position] = True
        elif side == "op":
            val_op[position] = True

    return ModelDataset(
        feature_names=names,
        x=x,
        y=y,
        matrix=matrix,
        val_fit=val_fit,
        val_op=val_op,
        val_boundary=boundary,
        val_purged=purged,
    )
