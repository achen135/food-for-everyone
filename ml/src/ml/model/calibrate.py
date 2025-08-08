"""Turning the booster's output into a probability, and placing the cut points.

## Why calibration is a deliverable rather than a nicety

LightGBM's binary objective emits a number in [0, 1], which is not the same
thing as a probability. The subsystem's output is a **risk tier** the product
escalates on, and a tier is only meaningful if "0.7" means "this happens about
seven times in ten". `ml/src/ml/eval/metrics.py` will only report a Brier score
and a reliability curve when the scores really are on a probability scale — it
refuses to rescale a scorer to make it look calibrated — so calibrating here is
what makes those two numbers exist at all for Model A. The rules baselines emit
ranks and have `brier: null`, by design.

## Isotonic, chosen up front

Isotonic rather than Platt, decided before fitting anything rather than by
trying both and keeping the winner — picking the calibration method by its score
on the calibration set is circular, and there is no fourth slice to arbitrate
with. The reasoning:

- `val_fit` has tens of thousands of rows, which is comfortably enough for a
  non-parametric fit. Platt's advantage is small-sample stability, which is not
  the situation here.
- Platt fits a sigmoid, so it can only correct a monotone squash. Gradient
  boosting's characteristic miscalibration is at the two extremes, where the
  raw output saturates asymmetrically; a sigmoid cannot straighten that and
  isotonic can.

If the reliability curve in the model card had come out as a staircase with
empty middle bins — isotonic's known failure mode — Platt would have been the
fallback. It did not; the curve is reported so the choice can be checked.

## Two cut points, both placed on `val_op`

- **`high`** is the operating point §5 asks for: the threshold that catches at
  least 80% of doomed listings, taking the best precision available at that
  recall. `evaluate_scores` already computes it, so the same code that reports
  the number chooses it.
- **`low`** is a judgement call, and this is the reasoning. Because the score is
  calibrated, the base rate is a meaningful place to cut: below it, a listing is
  *less* likely than an average open listing to be wasted, and there is nothing
  for an operator to do about it. So `low` is "calibrated risk below the
  observed base rate", measured on `val_op`. Everything between the two is
  `medium`.

Neither is chosen on `test`. `test` is read once, at the end, to report what
they cost.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.isotonic import IsotonicRegression

from ml.eval.metrics import evaluate_scores

__all__ = [
    "CALIBRATOR_DECIMALS",
    "Calibrator",
    "OperatingPoints",
    "choose_operating_points",
    "fit_calibrator",
]

#: Knots are rounded to this many decimal places before anything reads them.
#:
#: Measured, not guessed. Training the same corpus on arm64 and on x86_64
#: produces a **bit-identical booster** — `deterministic=true` delivers — but
#: `predict` differs in the last unit in the last place, so the isotonic knots
#: fitted on those predictions disagreed by up to 2.8e-17 and `model_a.json`
#: showed as changed while describing an identical model. Same failure
#: `round_floats` was added for in M12, one file further down.
#:
#: Rounded at fit time rather than on the way to disk, so the operating points,
#: the model card and the committed artifact are all computed from exactly the
#: numbers that get committed. Twelve places is six orders of magnitude finer
#: than the card reports and four coarser than the noise.
CALIBRATOR_DECIMALS: int = 12


@dataclass(frozen=True, slots=True)
class Calibrator:
    """An isotonic mapping, stored as its knots.

    Held as two arrays rather than a pickled estimator. A pickle would tie the
    committed artifact to the exact scikit-learn version that wrote it and make
    the serving path load executable state from disk; the knots are the entire
    content of the fit, they are inspectable in the committed JSON, and
    `np.interp` reproduces `IsotonicRegression.predict` exactly — it clamps
    outside the fitted range the same way `out_of_bounds="clip"` does. There is
    a test asserting that equivalence rather than a claim that it holds.
    """

    x: np.ndarray
    y: np.ndarray
    method: str = "isotonic"

    def apply(self, raw: np.ndarray) -> np.ndarray:
        return np.asarray(
            np.interp(np.asarray(raw, dtype=np.float64), self.x, self.y), dtype=np.float64
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "n_knots": int(self.x.size),
            "x": [float(value) for value in self.x],
            "y": [float(value) for value in self.y],
        }

    @classmethod
    def from_json(cls, document: dict[str, Any]) -> Calibrator:
        return cls(
            x=np.asarray(document["x"], dtype=np.float64),
            y=np.asarray(document["y"], dtype=np.float64),
            method=str(document.get("method", "isotonic")),
        )


@dataclass(frozen=True, slots=True)
class OperatingPoints:
    """The two tier boundaries and what they cost on the slice that set them."""

    threshold_high: float
    threshold_low: float
    recall_target: float
    val_op_precision: float | None
    val_op_recall: float | None
    val_op_base_rate: float
    recall_target_reachable: bool

    def tiers(self, scores: np.ndarray) -> np.ndarray:
        out = np.full(scores.shape, "medium", dtype=object)
        out[scores >= self.threshold_high] = "high"
        out[scores < self.threshold_low] = "low"
        return out

    def describe(self) -> dict[str, Any]:
        return {
            "chosen_on": "val_op",
            "recall_target": self.recall_target,
            "recall_target_reachable": self.recall_target_reachable,
            "threshold_high": self.threshold_high,
            "threshold_high_basis": (
                f"best precision among thresholds reaching recall >= {self.recall_target} on val_op"
            ),
            "threshold_low": self.threshold_low,
            "threshold_low_basis": (
                "the observed base rate on val_op; below it a listing is less likely "
                "than an average open listing to be wasted"
            ),
            "val_op_precision_at_target": self.val_op_precision,
            "val_op_recall_at_target": self.val_op_recall,
            "val_op_base_rate": self.val_op_base_rate,
        }


def fit_calibrator(raw: np.ndarray, y: np.ndarray) -> Calibrator:
    """Fit the isotonic mapping on `val_fit`.

    Rounding is monotone, so rounding the knots cannot break the isotonic
    guarantee that the mapping is non-decreasing.
    """
    model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    model.fit(np.asarray(raw, dtype=np.float64), np.asarray(y, dtype=np.float64))
    return Calibrator(
        x=np.round(np.asarray(model.X_thresholds_, dtype=np.float64), CALIBRATOR_DECIMALS),
        y=np.round(np.asarray(model.y_thresholds_, dtype=np.float64), CALIBRATOR_DECIMALS),
    )


def choose_operating_points(
    scores: np.ndarray, y: np.ndarray, recall_target: float
) -> OperatingPoints:
    """Place both cut points on `val_op`."""
    result = evaluate_scores(y, scores, recall_target)
    at_target = result["at_recall_target"]
    base_rate = float(np.asarray(y).mean())

    threshold_high = at_target["threshold"]
    if threshold_high is None:
        # Unreachable target: fall back to the most selective point available so
        # the tier still exists, and let the card say the goal was not met.
        threshold_high = float(np.max(scores))

    return OperatingPoints(
        threshold_high=float(threshold_high),
        threshold_low=base_rate,
        recall_target=recall_target,
        val_op_precision=at_target["precision"],
        val_op_recall=at_target["recall"],
        val_op_base_rate=base_rate,
        recall_target_reachable=bool(at_target["reachable"]),
    )
