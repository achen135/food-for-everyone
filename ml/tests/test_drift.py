"""PSI, and the monitoring pass that writes it.

The maths is tested against distributions whose answer is known by
construction — identical populations, a deliberate shift, a population that has
moved entirely outside the reference range. Those cases are the ones where a
plausible-looking wrong implementation differs from a right one.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from ml.drift.psi import (
    EPSILON,
    PSI_MODERATE,
    PSI_SIGNIFICANT,
    band,
    categorical_psi,
    numeric_edges,
    numeric_psi,
    psi_from_counts,
)

needs_postgres = pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs the corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)

CORPUS_AS_OF = "2025-06-13T23:00:00+00:00"


def _normal(n: int, loc: float = 0.0, scale: float = 1.0, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).normal(loc, scale, n)


# -- the statistic ----------------------------------------------------------


def test_identical_distributions_score_zero() -> None:
    values = _normal(20_000)
    assert numeric_psi("f", values, values).psi == pytest.approx(0.0, abs=1e-12)


def test_two_samples_of_the_same_distribution_are_stable() -> None:
    """Sampling noise must not read as drift, or every report cries wolf."""
    drift = numeric_psi("f", _normal(20_000, seed=1), _normal(20_000, seed=2))
    assert drift.psi < PSI_MODERATE
    assert drift.band == "stable"


def test_a_shifted_distribution_lands_in_the_expected_band() -> None:
    """A one-sigma shift is unambiguously significant on this convention."""
    drift = numeric_psi("f", _normal(20_000, loc=0.0, seed=1), _normal(20_000, loc=1.0, seed=2))
    assert drift.psi > PSI_SIGNIFICANT
    assert drift.band == "significant"


def test_a_small_shift_is_moderate_not_significant() -> None:
    """The middle band, pinned to a measured shift rather than a guessed one.

    Calibrated against this implementation: 0.2σ scores 0.044 (stable), 0.4σ
    scores 0.164 (moderate) and 0.5σ scores 0.252 (significant). The band
    boundaries are conventional, so what this really asserts is that the scale
    behaves — a modest shift must not be dressed up as a significant one.
    """
    drift = numeric_psi("f", _normal(50_000, loc=0.0, seed=1), _normal(50_000, loc=0.4, seed=2))
    assert PSI_MODERATE <= drift.psi < PSI_SIGNIFICANT
    assert drift.band == "moderate"


def test_a_population_outside_the_reference_range_is_not_reported_stable() -> None:
    """The failure mode that dropping empty buckets would produce.

    Every current value sits above every reference value. An implementation
    that skips buckets where either side is empty scores this 0.0 — the most
    stable possible answer for the most drifted possible data. Flooring the
    proportions instead keeps it finite *and* large.
    """
    drift = numeric_psi("f", _normal(10_000, loc=0.0, seed=1), _normal(10_000, loc=50.0, seed=2))
    assert np.isfinite(drift.psi)
    assert drift.psi > 1.0


def test_null_rate_shifts_are_visible() -> None:
    """Nulls are their own bucket, so a change in nullity is drift.

    A cohort of first-time donors (no prior claim rate) arriving in bulk moves
    nothing but the null share, and it must not be silently dropped.
    """
    reference = np.concatenate([_normal(9_000, seed=1), np.full(1_000, np.nan)])
    current = np.concatenate([_normal(5_000, seed=2), np.full(5_000, np.nan)])
    drift = numeric_psi("donor_prior_claim_rate", reference, current)

    assert drift.reference_null_rate == pytest.approx(0.10)
    assert drift.current_null_rate == pytest.approx(0.50)
    assert drift.band == "significant"


def test_an_empty_current_window_scores_zero_rather_than_infinity() -> None:
    """No evidence of a shift is not the same as evidence of no shift.

    Nothing to compare is reported as 0.0 beside a `current_n` of 0, so a
    reader can tell the two apart. An unguarded formula would divide by zero.
    """
    drift = numeric_psi("f", _normal(1_000), np.asarray([], dtype=float))
    assert drift.psi == 0.0
    assert drift.current_n == 0


def test_counts_of_different_lengths_are_refused() -> None:
    with pytest.raises(ValueError, match="differ in shape"):
        psi_from_counts(np.asarray([1.0, 2.0]), np.asarray([1.0, 2.0, 3.0]))


def test_psi_is_symmetric_in_its_two_populations() -> None:
    a, b = _normal(20_000, seed=1), _normal(20_000, loc=0.6, seed=2)
    counts_a = np.histogram(a, bins=10, range=(-4, 5))[0].astype(float)
    counts_b = np.histogram(b, bins=10, range=(-4, 5))[0].astype(float)
    assert psi_from_counts(counts_a, counts_b) == pytest.approx(
        psi_from_counts(counts_b, counts_a), rel=1e-9
    )


def test_the_epsilon_floor_bounds_an_empty_bucket() -> None:
    """One empty bucket contributes a large but finite amount, not `inf`."""
    expected = np.asarray([50.0, 50.0])
    actual = np.asarray([100.0, 0.0])
    value = psi_from_counts(expected, actual)
    assert np.isfinite(value)
    assert value < abs(np.log(EPSILON)) * 2


# -- binning ----------------------------------------------------------------


def test_edges_are_deduplicated_for_a_mostly_constant_feature() -> None:
    """`donor_prior_listings` is 0 for every first-time donor.

    Repeated quantiles would create zero-width buckets, empty by construction
    on both sides, inflating the bucket count without adding information.
    """
    values = np.concatenate([np.zeros(9_000), np.arange(1_000, dtype=float)])
    edges = numeric_edges(values)
    assert edges.size == np.unique(edges).size


def test_edges_come_from_the_reference_only() -> None:
    """Re-deriving bins per window would report ~0 for every distribution."""
    reference = _normal(10_000, seed=1)
    shifted = _normal(10_000, loc=3.0, seed=2)
    assert numeric_edges(reference).tolist() == numeric_edges(reference).tolist()
    assert numeric_edges(reference).tolist() != numeric_edges(shifted).tolist()


def test_a_reference_of_all_nulls_produces_no_edges() -> None:
    assert numeric_edges(np.full(100, np.nan)).size == 0


# -- categorical ------------------------------------------------------------


def test_categorical_psi_notices_a_level_disappearing() -> None:
    reference = ["bakery"] * 500 + ["produce"] * 500
    current = ["bakery"] * 1_000
    assert categorical_psi("food_category", reference, current).band == "significant"


def test_categorical_psi_is_zero_for_identical_populations() -> None:
    values = ["bakery"] * 300 + ["produce"] * 700
    assert categorical_psi("food_category", values, values).psi == pytest.approx(0.0, abs=1e-12)


def test_none_is_a_level_not_a_dropped_row() -> None:
    reference: list[object] = ["bakery"] * 900 + [None] * 100
    current: list[object] = ["bakery"] * 500 + [None] * 500
    drift = categorical_psi("food_category", reference, current)
    assert drift.reference_null_rate == pytest.approx(0.10)
    assert drift.current_null_rate == pytest.approx(0.50)
    assert drift.psi > 0.0


def test_level_order_does_not_depend_on_insertion_order() -> None:
    """Determinism: sorted levels, not dict or set iteration order."""
    a = categorical_psi("f", ["x"] * 10 + ["y"] * 5, ["y"] * 5 + ["x"] * 10)
    b = categorical_psi("f", ["y"] * 5 + ["x"] * 10, ["x"] * 10 + ["y"] * 5)
    assert a.psi == pytest.approx(b.psi)


# -- bands ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "stable"),
        (0.099, "stable"),
        (PSI_MODERATE, "moderate"),
        (0.24, "moderate"),
        (PSI_SIGNIFICANT, "significant"),
        (5.0, "significant"),
    ],
)
def test_band_boundaries(value: float, expected: str) -> None:
    assert band(value) == expected


# -- the monitoring pass ----------------------------------------------------


@needs_postgres
def test_a_drift_pass_writes_a_metric_history_row() -> None:
    from ml.db import connect
    from ml.drift.__main__ import run_drift, write_metric_history

    report = run_drift("corpus", CORPUS_AS_OF)
    row_id = write_metric_history(report)

    try:
        with connect() as conn:
            row = conn.execute(
                "select model_version, metrics, psi from public.metric_history where id = %s",
                (row_id,),
            ).fetchone()

        assert row is not None
        model_version, metrics, psi = row
        assert model_version.startswith("model_a-")
        assert metrics["current_n"] > 0
        assert metrics["reference_n"] > 0
        assert "__score__" in psi
        # Every model feature is covered, so a new feature cannot be added to
        # the model and silently escape monitoring.
        assert set(psi) - {"__score__"} == {d.feature for d in report.features}
    finally:
        with connect() as conn:
            conn.execute("delete from public.metric_history where id = %s", (row_id,))


@needs_postgres
def test_the_corpus_window_is_not_a_single_instant() -> None:
    """The bug this test exists for: a window that never advanced the log.

    An earlier implementation walked an hourly cursor across a `ScoringService`
    warmed only to the window's start, so no new listing could ever appear and
    the population decayed to nothing within a day. `as_of_dow` sat at 88% on
    one day and `as_of_hour` scored PSI 11.79 against a reference spanning all
    twenty-four hours.

    A correct week-long window sees every hour of the day, so the clock
    features — which cannot drift in a stationary simulator — must read stable.
    """
    from ml.drift.__main__ import run_drift

    report = run_drift("corpus", CORPUS_AS_OF, window_hours=168)
    by_name = {d.feature: d for d in report.features}

    assert report.current_n > 1_000, "a week of hourly observations should be substantial"
    assert by_name["as_of_hour"].band == "stable"
    assert by_name["as_of_dow"].band == "stable"
    assert by_name["posted_dow"].band == "stable"


@needs_postgres
def test_the_score_distribution_is_stable_within_the_corpus() -> None:
    """The corpus is generated by one stationary process, so scores should not
    drift against the split it trained on. A significant reading here would
    mean the pipeline or the model changed, not the world."""
    from ml.drift.__main__ import run_drift

    report = run_drift("corpus", CORPUS_AS_OF)
    assert band(report.score_psi) == "stable"
