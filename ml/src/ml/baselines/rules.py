"""The two rules baselines, as scorers.

## Why they are scorers rather than yes/no rules

The brief states them as predicates — "hours to `pickup_end` < k", "recipients
in radius = 0". A predicate gives one operating point, and one point cannot be
compared with a model that outputs a probability: you can quote its precision
and recall, but not ROC-AUC, not PR-AUC, and not a calibration number.

So each baseline is expressed as a **monotone score** over the same feature, and
the threshold sweep is recovered from it. `hours_to_pickup_end` is a continuous
feature, so "< k for the best k" is exactly the operating point picked by
sweeping thresholds on the score `-hours_to_pickup_end` — the rule is not
weakened, it is generalised, and the sweep is now visible as a curve instead of
buried in a constant.

That also keeps the comparison honest in the other direction. Handing M13's
model a full PR curve while giving the baseline a single point would flatter the
model at exactly the place where the comparison matters.

## The k sweep

`--sweep` reports precision and recall for a grid of k on the **validation**
split, so the chosen operating point is picked without touching test. The test
split is M13's judge and this milestone does not spend it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

import numpy as np

from ml.features.writer import FeatureMatrix

__all__ = ["BASELINES", "HOURS_GRID", "RADIUS_COUNT_GRID", "Baseline", "score_baseline"]


@dataclass(frozen=True, slots=True)
class Baseline:
    key: str
    name: str
    rule: str
    #: Maps the feature matrix (restricted to a split) to a score where higher
    #: means "more likely to be wasted".
    score: Callable[[FeatureMatrix, str], np.ndarray]
    #: What the operating-point sweep varies, for reporting.
    sweep_feature: str
    sweep_grid: tuple[float, ...]
    #: How to read a swept threshold back as the rule's own parameter.
    sweep_label: str
    notes: str = ""


#: Values of k for "hours to pickup_end < k". Dense where the corpus's pickup
#: windows actually live (a median window is under six hours).
HOURS_GRID: Final[tuple[float, ...]] = (
    0.5,
    1.0,
    1.5,
    2.0,
    3.0,
    4.0,
    6.0,
    8.0,
    12.0,
    18.0,
    24.0,
    36.0,
    48.0,
)

#: Values of k for "recipients within 15 km <= k".
#:
#: Spans the whole observed range, which is bimodal and very wide: a quarter of
#: observations see 10 or fewer recipients within 15 km and the median sees 241.
#: An earlier grid stopped at 30 and could not reach the 0.8 recall target at
#: all, so the operating-point search fell back to "highest recall on the grid"
#: and reported a rule far weaker than the feature actually supports. The grid
#: has to cover the feature, not the range that seemed plausible.
RADIUS_COUNT_GRID: Final[tuple[float, ...]] = (
    0.0,
    1.0,
    2.0,
    3.0,
    5.0,
    8.0,
    12.0,
    20.0,
    40.0,
    80.0,
    150.0,
    250.0,
    350.0,
)


def _time_pressure(matrix: FeatureMatrix, split: str) -> np.ndarray:
    """Score for "the window is closing".

    Negated hours-to-close, so higher means more urgent and the ranking matches
    the rule's direction. Kept on the raw hours scale rather than squashed into
    [0, 1]: it is not a probability and presenting it as one would invite a
    calibration number that means nothing. `evaluate_scores` notices, and
    reports `brier: null` rather than rescaling.
    """
    return -matrix.column("hours_to_pickup_end", split)


def _recipient_scarcity(matrix: FeatureMatrix, split: str) -> np.ndarray:
    """Score for "nobody is near enough to take it".

    The brief's rule is `recipients in radius == 0`. As a *score* this is
    `-recipients_within_15km`, whose threshold sweep includes that predicate at
    k = 0 and also covers the graded version — which matters here, because on
    this corpus the strict `== 0` case is rare (see `notes` below) and a
    baseline that almost never fires is not a fair bar.
    """
    return -matrix.column("recipients_within_15km", split)


BASELINES: Final[tuple[Baseline, ...]] = (
    Baseline(
        key="time_pressure",
        name="Hours to pickup_end",
        rule="predict wasted when hours_to_pickup_end < k",
        score=_time_pressure,
        sweep_feature="hours_to_pickup_end",
        sweep_grid=HOURS_GRID,
        sweep_label="k hours",
        notes=(
            "The obvious rule, and a genuinely strong one: a listing minutes from "
            "its deadline with nobody holding it is usually lost. What it cannot "
            "see is that the same number of hours means different things at "
            "different times of day — four hours at 09:00 is plenty and four "
            "hours at 03:00 is nothing, because recipients are shut."
        ),
    ),
    Baseline(
        key="recipient_scarcity",
        name="Recipients within 15 km",
        rule="predict wasted when recipients_within_15km <= k (k = 0 is the brief's rule)",
        score=_recipient_scarcity,
        sweep_feature="recipients_within_15km",
        sweep_grid=RADIUS_COUNT_GRID,
        sweep_label="k recipients",
        notes=(
            "Recipient geography as-of is a PROXY, and a lossy one. The event log "
            "has no organization-registration event, so a recipient becomes "
            "visible to the pipeline only once it has claimed something — it can "
            "sit two kilometres away, fully registered and reachable in the "
            "product, and be invisible here until its first claim. The count is "
            "therefore biased low, and most severely at the start of the corpus, "
            "when almost nothing has been claimed yet. "
            "MEASURED CONSEQUENCE: the brief's literal predicate, "
            "`recipients_within_15km == 0`, fires on 172 of 438,093 observations "
            "(0.04%), and the waste rate among them is 31.4% — BELOW the 45.7% "
            "base rate. As written, the rule is worse than guessing, and it is "
            "worse for a structural reason rather than a tuning one: a zero count "
            "means 'nothing has been claimed near here yet', which early in the "
            "corpus mostly means 'it is early', not 'this donor is isolated'. "
            "The graded version is a real signal — 1-5 recipients nearby carries "
            "a 76.2% waste rate against 34.0% at 151+ — which is why the sweep "
            "covers k > 0 and why the reported operating point is not k = 0. "
            "Any model using this feature would improve immediately if FFE "
            "emitted an org-registration event; that is the cleanest argument "
            "this subsystem has for adding one."
        ),
    ),
)


def score_baseline(baseline: Baseline, matrix: FeatureMatrix, split: str) -> np.ndarray:
    return baseline.score(matrix, split)


def sweep_operating_points(
    baseline: Baseline, matrix: FeatureMatrix, split: str
) -> list[dict[str, float]]:
    """Precision and recall for each k in the rule's own units.

    Reported so the rule can be read the way it was written — "fire when fewer
    than three hours remain" — rather than only as a curve.
    """
    values = matrix.column(baseline.sweep_feature, split)
    labels = matrix.labels(split).astype(int)
    positives = int(labels.sum())

    points: list[dict[str, float]] = []
    for k in baseline.sweep_grid:
        fired = values <= k
        fired_count = int(fired.sum())
        hits = int(labels[fired].sum()) if fired_count else 0
        points.append(
            {
                "k": float(k),
                "fires_on": fired_count,
                "fire_rate": fired_count / labels.size if labels.size else 0.0,
                "precision": (hits / fired_count) if fired_count else 0.0,
                "recall": (hits / positives) if positives else 0.0,
            }
        )
    return points
