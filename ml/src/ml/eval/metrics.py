"""Metrics for a binary scorer, and the reasoning about which one leads.

## PR-AUC is primary, and accuracy is not reported at all

The positive class is a minority — around a fifth of labelled observations.
On data like that, accuracy is worse than useless: a model that predicts "never
wasted" for everything scores ~80% and has no value whatsoever. It is the
number most likely to be quoted and least likely to mean anything, so it is not
computed here (`docs/ML Subsystem.md` §6 rules it out of the résumé for exactly
this reason).

**ROC-AUC** is reported but is not the headline either. It is insensitive to
class imbalance in a way that flatters: a large gain in ranking among the
negatives moves it a lot while changing nothing a user would notice.

**PR-AUC (average precision)** is the primary metric because it answers the
operational question — of the listings this thing flags, how many are really
going to be wasted? Its floor is the base rate, so it is always reported
alongside `base_rate` and `lift_over_base`: a PR-AUC of 0.45 is a strong result
at a 20% base rate and a poor one at 40%, and quoting it bare hides which.

**Precision and recall at a recall target** is what an operator actually
configures. The goal in §5 is stated as "catch ≥80% of doomed listings at ≤25%
false-alarm rate", so the harness finds the threshold that hits the recall
target and reports the precision it costs.

**Brier score and a reliability curve** measure calibration — whether a score of
0.7 means it happens 70% of the time. Worth stating clearly for M12: the rules
baselines emit *ranks*, not probabilities, so their calibration numbers are not
a criticism of them. They are the floor M13's calibrated model has to beat, and
recording them now is what makes that comparison possible later.
"""

from __future__ import annotations

from itertools import pairwise
from typing import Any

import numpy as np
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    precision_recall_curve,
    roc_auc_score,
)

__all__ = ["DEFAULT_RECALL_TARGET", "evaluate_scores", "reliability_curve"]

#: §5's stated goal: catch at least this share of doomed listings.
DEFAULT_RECALL_TARGET: float = 0.80

#: Bins for the reliability curve.
RELIABILITY_BINS: int = 10


def reliability_curve(
    y_true: np.ndarray, y_score: np.ndarray, bins: int = RELIABILITY_BINS
) -> list[dict[str, float]]:
    """Observed frequency against predicted score, in equal-width bins.

    Equal-width rather than equal-count: the question is "when this thing says
    0.9, how often is it right?", which is about the score axis. Empty bins are
    dropped rather than reported as zero — a bin with no rows is not evidence of
    poor calibration, and a rules baseline puts everything in two bins.
    """
    edges = np.linspace(0.0, 1.0, bins + 1)
    out: list[dict[str, float]] = []
    for lower, upper in pairwise(edges):
        in_bin = (y_score >= lower) & (y_score < upper if upper < 1.0 else y_score <= upper)
        count = int(in_bin.sum())
        if count == 0:
            continue
        out.append(
            {
                "bin_lower": float(lower),
                "bin_upper": float(upper),
                "count": count,
                "mean_score": float(y_score[in_bin].mean()),
                "observed_rate": float(y_true[in_bin].mean()),
            }
        )
    return out


def _at_recall_target(
    y_true: np.ndarray, y_score: np.ndarray, target: float
) -> dict[str, float | None]:
    """Best precision among thresholds reaching `target` recall."""
    precision, recall, thresholds = precision_recall_curve(y_true, y_score)
    # precision_recall_curve returns one more point than thresholds; the last
    # point is (precision=1, recall=0) with no threshold behind it.
    precision, recall = precision[:-1], recall[:-1]
    reachable = recall >= target
    if not reachable.any():
        return {
            "recall_target": target,
            "threshold": None,
            "precision": None,
            "recall": float(recall.max()) if recall.size else None,
            "reachable": False,
        }
    index = int(np.argmax(np.where(reachable, precision, -np.inf)))
    return {
        "recall_target": target,
        "threshold": float(thresholds[index]),
        "precision": float(precision[index]),
        "recall": float(recall[index]),
        "reachable": True,
    }


def evaluate_scores(
    y_true: np.ndarray,
    y_score: np.ndarray,
    recall_target: float = DEFAULT_RECALL_TARGET,
) -> dict[str, Any]:
    """Every metric for one scorer on one split."""
    y_true = np.asarray(y_true).astype(int)
    y_score = np.asarray(y_score).astype(float)

    if y_true.shape != y_score.shape:
        raise ValueError(f"shape mismatch: labels {y_true.shape}, scores {y_score.shape}")
    if y_true.size == 0:
        raise ValueError("no rows to evaluate")

    positives = int(y_true.sum())
    base_rate = positives / y_true.size

    if positives == 0 or positives == y_true.size:
        raise ValueError(
            f"split has a single class ({positives} positives of {y_true.size}); "
            "AUC is undefined and the split is not usable"
        )

    pr_auc = float(average_precision_score(y_true, y_score))

    # Brier needs a score in [0, 1]. A rules baseline may not produce one, so
    # it is reported only when the scores really are probabilities rather than
    # silently rescaling them, which would make a badly calibrated scorer look
    # calibrated.
    in_unit_interval = bool(np.all((y_score >= 0.0) & (y_score <= 1.0)))

    return {
        "n": int(y_true.size),
        "n_positive": positives,
        "base_rate": base_rate,
        "roc_auc": float(roc_auc_score(y_true, y_score)),
        "pr_auc": pr_auc,
        "lift_over_base": pr_auc / base_rate,
        "brier": float(brier_score_loss(y_true, y_score)) if in_unit_interval else None,
        "calibrated_scale": in_unit_interval,
        "at_recall_target": _at_recall_target(y_true, y_score, recall_target),
        "reliability": reliability_curve(y_true, y_score) if in_unit_interval else [],
    }
