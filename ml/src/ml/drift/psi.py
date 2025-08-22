"""Population Stability Index — the drift statistic, and its sharp edges.

## The measure

For a feature binned into *k* buckets, with `e_i` the share of the **reference**
population in bucket *i* and `a_i` the share of the **current** one:

    PSI = Σ (a_i − e_i) · ln(a_i / e_i)

It is the symmetrised KL divergence between two discretised distributions, and
it is standard in exactly the way that matters here: the thresholds below are
the ones a reviewer will expect, so a number computed some other way would
carry the wrong connotation.

    < 0.10   stable
    0.10–0.25  moderate shift — worth looking at
    > 0.25   significant shift

## The three decisions that make it well-defined

Every PSI implementation has to answer these and they are usually left silent.

**1. Bin edges come from the reference, and are frozen.** Quantile edges over
the *training* distribution, computed once, then applied unchanged to the
current window. Re-deriving edges per window would compare each population to
its own shape and report ~0 for every distribution on earth.

**2. Empty buckets are floored, not dropped.** `ln(0)` is −∞ and `a_i/0` is
undefined, so a bucket that is empty on either side would make the whole
statistic infinite — meaning a single unseen value could dominate the report.
Each proportion is floored at `EPSILON`, which bounds one empty bucket's
contribution to roughly `ln(1/EPSILON)` scaled by its reference share. Dropping
empty buckets instead is the common shortcut and is wrong in a specific way: a
feature whose values have moved *entirely* outside the reference range would
score 0, the most stable possible answer, for the most drifted possible data.

**3. Missing values are their own bucket.** Nullable features here
(`donor_prior_claim_rate`, `donor_median_claim_latency`, …) are null for a
*reason* — the donor has no prior listings — so the share that is null is
itself a distribution worth watching. Folding nulls into a numeric bucket, or
dropping them, hides a real shift: a sudden influx of first-time donors moves
nothing but the null rate.

## What this file does not do

It does not alert, page, retrain, or gate. `docs/ML Subsystem.md` §2 puts
champion/challenger and a retraining loop explicitly out of scope, and a
monitor that cannot act is honest about being a monitor. The numbers are
written to `metric_history` and logged.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

import numpy as np

__all__ = [
    "DEFAULT_BINS",
    "EPSILON",
    "PSI_MODERATE",
    "PSI_SIGNIFICANT",
    "FeatureDrift",
    "band",
    "categorical_psi",
    "numeric_edges",
    "numeric_psi",
    "psi_from_counts",
]

#: Conventional thresholds. Named rather than inlined so the report, the tests
#: and the docs cannot drift apart from each other while measuring drift.
PSI_MODERATE: Final[float] = 0.10
PSI_SIGNIFICANT: Final[float] = 0.25

#: Proportion floor. Small enough not to perturb a populated bucket, large
#: enough to keep an empty one finite — see decision 2 above.
EPSILON: Final[float] = 1e-6

DEFAULT_BINS: Final[int] = 10


@dataclass(frozen=True, slots=True)
class FeatureDrift:
    """One feature's PSI, with enough detail to explain it."""

    feature: str
    psi: float
    band: str
    kind: str
    bins: int
    reference_n: int
    current_n: int
    reference_null_rate: float
    current_null_rate: float

    def as_json(self) -> dict[str, object]:
        return {
            "psi": round(self.psi, 6),
            "band": self.band,
            "kind": self.kind,
            "bins": self.bins,
            "reference_n": self.reference_n,
            "current_n": self.current_n,
            "reference_null_rate": round(self.reference_null_rate, 6),
            "current_null_rate": round(self.current_null_rate, 6),
        }


def band(value: float) -> str:
    """Which of the three conventional bands `value` falls in."""
    if value < PSI_MODERATE:
        return "stable"
    if value < PSI_SIGNIFICANT:
        return "moderate"
    return "significant"


def psi_from_counts(expected: np.ndarray, actual: np.ndarray) -> float:
    """PSI between two bucket-count vectors of the same length.

    The only place the formula itself lives. Both vectors are normalised here
    rather than by callers, so a caller cannot accidentally pass one as counts
    and the other as proportions.
    """
    if expected.shape != actual.shape:
        raise ValueError(f"bucket counts differ in shape: {expected.shape} vs {actual.shape}")

    expected_total = float(expected.sum())
    actual_total = float(actual.sum())
    if expected_total <= 0 or actual_total <= 0:
        # No reference population, or nothing to compare against it. Zero is
        # the honest answer: there is no evidence of a shift, as distinct from
        # evidence of no shift. The caller reports the sample sizes beside it.
        return 0.0

    e = np.maximum(expected / expected_total, EPSILON)
    a = np.maximum(actual / actual_total, EPSILON)
    return float(np.sum((a - e) * np.log(a / e)))


def numeric_edges(reference: np.ndarray, bins: int = DEFAULT_BINS) -> np.ndarray:
    """Interior quantile edges of `reference`, deduplicated.

    Duplicates are dropped because a feature that is mostly one value —
    `donor_prior_listings` is 0 for every first-time donor — produces repeated
    quantiles, and repeated edges would create zero-width buckets that are
    empty by construction on both sides. `np.unique` sorts and dedupes in one
    pass. The result may have fewer than `bins - 1` edges, which is correct:
    the feature genuinely has fewer distinguishable levels.

    Returns interior edges only; `np.digitize` supplies the outer two buckets,
    which is what makes values outside the reference range land somewhere
    rather than being clipped into the extreme bucket and hidden.
    """
    finite = reference[np.isfinite(reference)]
    if finite.size == 0:
        return np.asarray([], dtype=float)
    quantiles = np.linspace(0.0, 1.0, bins + 1)[1:-1]
    return np.unique(np.quantile(finite, quantiles))


def _bucket_counts(values: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Counts per bucket, with the null bucket last."""
    finite_mask = np.isfinite(values)
    finite = values[finite_mask]
    indices = np.digitize(finite, edges, right=False)
    counts = np.bincount(indices, minlength=edges.size + 1).astype(float)
    return np.append(counts, float((~finite_mask).sum()))


def numeric_psi(
    feature: str,
    reference: np.ndarray,
    current: np.ndarray,
    bins: int = DEFAULT_BINS,
) -> FeatureDrift:
    """PSI for a continuous or ordinal feature."""
    reference = np.asarray(reference, dtype=float)
    current = np.asarray(current, dtype=float)

    edges = numeric_edges(reference, bins)
    expected = _bucket_counts(reference, edges)
    actual = _bucket_counts(current, edges)
    value = psi_from_counts(expected, actual)

    return FeatureDrift(
        feature=feature,
        psi=value,
        band=band(value),
        kind="numeric",
        bins=int(expected.size),
        reference_n=int(reference.size),
        current_n=int(current.size),
        reference_null_rate=_null_rate(reference),
        current_null_rate=_null_rate(current),
    )


def categorical_psi(
    feature: str, reference: Sequence[object], current: Sequence[object]
) -> FeatureDrift:
    """PSI for a categorical feature; `None` is a level like any other.

    Levels are the union of both populations, **sorted**, so the bucket order
    is a function of the data rather than of dict insertion order — the same
    determinism discipline the simulator follows (no `hash()`, no set iteration
    on a path whose output is committed).
    """
    levels = sorted({_level(v) for v in reference} | {_level(v) for v in current})
    index = {level: i for i, level in enumerate(levels)}

    expected = np.zeros(len(levels), dtype=float)
    actual = np.zeros(len(levels), dtype=float)
    for value in reference:
        expected[index[_level(value)]] += 1
    for value in current:
        actual[index[_level(value)]] += 1

    value = psi_from_counts(expected, actual)
    return FeatureDrift(
        feature=feature,
        psi=value,
        band=band(value),
        kind="categorical",
        bins=len(levels),
        reference_n=len(reference),
        current_n=len(current),
        reference_null_rate=_none_rate(reference),
        current_null_rate=_none_rate(current),
    )


def _level(value: object) -> str:
    return "\x00null" if value is None else str(value)


def _null_rate(values: np.ndarray) -> float:
    return 0.0 if values.size == 0 else float((~np.isfinite(values)).mean())


def _none_rate(values: Sequence[object]) -> float:
    return 0.0 if not values else sum(1 for v in values if v is None) / len(values)
