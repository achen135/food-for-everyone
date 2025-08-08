"""Model A — the claims the model half makes, checked.

Most of these need neither a database nor a training run: the artifact and the
card are **committed**, so the assertions that matter to the definition of done
— beats both baselines, meets the stated goal, is calibrated — can be made in
CI against the files themselves. The expensive check (that those committed
numbers still fall out of the corpus) is marked `postgres` and skips loudly
when there is no corpus to check against, the same way the M12 baseline
reproducibility test does.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pytest

from ml.eval.splits import bisect_by_time
from ml.features.spec import FEATURE_NAMES
from ml.model.artifact import CARD_FILE, MODEL_DIR, SHAP_FILE, compute_model_version, load_model_a
from ml.model.calibrate import (
    CALIBRATOR_DECIMALS,
    Calibrator,
    OperatingPoints,
    fit_calibrator,
)
from ml.model.dataset import EXCLUDED_FEATURES
from ml.model.explain import shap_summary, verify_additivity
from ml.model.search import BASE_PARAMS

BASELINES_JSON = Path(__file__).resolve().parent.parent / "baselines.json"

needs_postgres = pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs the corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)


def _card() -> dict[str, Any]:
    card: dict[str, Any] = json.loads((MODEL_DIR / CARD_FILE).read_text())
    return card


# -- dividing val -----------------------------------------------------------


def test_bisect_produces_time_disjoint_slices() -> None:
    """The property the whole sub-split exists for: no `as_of` overlap.

    Calibrating on rows that interleave in time with the rows that place the
    threshold would defeat the point of separating them at all.
    """
    spans = {f"listing-{i}": (float(i), float(i) + 0.5) for i in range(100)}
    assignment, boundary, _ = bisect_by_time(spans)

    fit_times = [spans[k][1] for k, side in assignment.items() if side == "fit"]
    op_times = [spans[k][0] for k, side in assignment.items() if side == "op"]

    assert fit_times and op_times
    assert max(fit_times) < boundary <= min(op_times)


def test_bisect_purges_listings_that_straddle_the_cut() -> None:
    """A listing observed on both sides of the boundary belongs to neither."""
    spans = {
        "early": (0.0, 1.0),
        "straddles": (4.0, 6.0),
        "late": (9.0, 10.0),
    }
    assignment, boundary, purged = bisect_by_time(spans)

    assert boundary == 5.0
    assert purged == 1
    assert "straddles" not in assignment
    assert assignment == {"early": "fit", "late": "op"}


def test_bisect_rejects_an_empty_split() -> None:
    with pytest.raises(ValueError, match="no listings"):
        bisect_by_time({})


# -- calibration ------------------------------------------------------------


def test_calibrator_reproduces_sklearn_isotonic() -> None:
    """`Calibrator.apply` claims to be `IsotonicRegression.predict`. Check it.

    The committed artifact stores isotonic knots rather than a pickled
    estimator, and `np.interp` over those knots is asserted — not assumed — to
    be the same function, including the clamping that `out_of_bounds="clip"`
    does outside the fitted range.
    """
    from sklearn.isotonic import IsotonicRegression

    rng = np.random.default_rng(0)
    raw = rng.uniform(0.0, 1.0, size=2000)
    y = (rng.uniform(size=2000) < raw).astype(int)

    reference = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y)
    calibrator = fit_calibrator(raw, y)

    probe = np.concatenate([raw, np.array([-5.0, -0.1, 1.1, 42.0])])
    # atol covers the knot rounding in `fit_calibrator` (CALIBRATOR_DECIMALS),
    # which is there so `model_a.json` is byte-stable across architectures.
    np.testing.assert_allclose(calibrator.apply(probe), reference.predict(probe), atol=1e-11)


def test_calibrator_knots_are_rounded_for_byte_stability() -> None:
    """Full-precision knots made `model_a.json` differ arm64 vs x86_64."""
    rng = np.random.default_rng(4)
    raw = rng.uniform(size=800)
    y = (rng.uniform(size=800) < raw).astype(int)

    calibrator = fit_calibrator(raw, y)
    for knots in (calibrator.x, calibrator.y):
        np.testing.assert_array_equal(knots, np.round(knots, CALIBRATOR_DECIMALS))


def test_calibrator_round_trips_through_json() -> None:
    rng = np.random.default_rng(1)
    raw = rng.uniform(size=500)
    y = (rng.uniform(size=500) < raw).astype(int)

    calibrator = fit_calibrator(raw, y)
    restored = Calibrator.from_json(json.loads(json.dumps(calibrator.to_json())))

    np.testing.assert_allclose(calibrator.apply(raw), restored.apply(raw), atol=0.0)


def test_calibrated_scores_stay_in_the_unit_interval() -> None:
    """`evaluate_scores` only reports Brier when scores are probabilities."""
    rng = np.random.default_rng(2)
    raw = rng.uniform(size=1000)
    y = (rng.uniform(size=1000) < raw).astype(int)

    scores = fit_calibrator(raw, y).apply(np.linspace(-3.0, 4.0, 200))
    assert scores.min() >= 0.0
    assert scores.max() <= 1.0


# -- tiers ------------------------------------------------------------------


def test_tiers_respect_both_boundaries() -> None:
    points = OperatingPoints(
        threshold_high=0.7,
        threshold_low=0.45,
        recall_target=0.8,
        val_op_precision=0.9,
        val_op_recall=0.8,
        val_op_base_rate=0.45,
        recall_target_reachable=True,
    )
    tiers = points.tiers(np.array([0.0, 0.44, 0.45, 0.69, 0.7, 1.0]))
    assert list(tiers) == ["low", "low", "medium", "medium", "high", "high"]


# -- model_version ----------------------------------------------------------


def test_model_version_is_stable_and_sensitive() -> None:
    """Same inputs, same version; any input that matters, a different one."""
    corpus = {"events": 10, "listings": 3}
    names = ["a", "b"]
    params = {"learning_rate": 0.1, "num_leaves": 31}

    base = compute_model_version(corpus, names, params, 50)
    assert base == compute_model_version(corpus, names, params, 50)
    assert base.startswith("model_a-v1-")

    assert base != compute_model_version({"events": 11, "listings": 3}, names, params, 50)
    assert base != compute_model_version(corpus, ["a", "c"], params, 50)
    assert base != compute_model_version(corpus, names, {**params, "num_leaves": 63}, 50)
    assert base != compute_model_version(corpus, names, params, 51)


# -- SHAP -------------------------------------------------------------------


@pytest.fixture(scope="module")
def toy_booster() -> tuple[lgb.Booster, np.ndarray, list[str]]:
    """A small model where feature 0 carries the signal and feature 1 is noise."""
    rng = np.random.default_rng(7)
    x = rng.normal(size=(4000, 2))
    y = (x[:, 0] + rng.normal(scale=0.25, size=4000) > 0).astype(int)
    names = ["signal", "noise"]
    booster = lgb.train(
        {**BASE_PARAMS, "learning_rate": 0.1, "num_leaves": 15, "min_data_in_leaf": 40},
        lgb.Dataset(x, label=y, feature_name=names),
        num_boost_round=40,
    )
    return booster, x, names


def test_treeshap_contributions_are_additive(
    toy_booster: tuple[lgb.Booster, np.ndarray, list[str]],
) -> None:
    """The guarantee that makes these SHAP values rather than a heuristic.

    Contributions plus the base value must equal the model's raw output for
    every row. This is also the check that would catch `pred_contrib` being
    something other than the TreeSHAP the model card claims it is.
    """
    booster, x, _ = toy_booster
    assert verify_additivity(booster, x, num_iteration=40) < 1e-6


def test_shap_summary_ranks_the_informative_feature_first(
    toy_booster: tuple[lgb.Booster, np.ndarray, list[str]],
) -> None:
    booster, x, names = toy_booster
    summary = shap_summary(booster, x, names, num_iteration=40, split_name="toy")

    assert [entry["feature"] for entry in summary["features"]] == ["signal", "noise"]
    assert summary["features"][0]["share"] > 0.9
    assert summary["rows_sampled"] == x.shape[0]


# -- the committed bundle ---------------------------------------------------


def test_committed_bundle_loads_and_agrees_with_the_feature_contract() -> None:
    model = load_model_a()
    expected = [name for name in FEATURE_NAMES if name not in EXCLUDED_FEATURES]

    assert model.feature_names == expected
    assert model.model_version.startswith("model_a-v1-")
    assert 0.0 < model.operating_points.threshold_low < model.operating_points.threshold_high < 1.0


def test_committed_bundle_scores_in_the_unit_interval() -> None:
    model = load_model_a()
    card = _card()
    rng = np.random.default_rng(3)
    x = rng.normal(size=(64, len(model.feature_names))) * 10.0

    scores = model.score(x)
    assert scores.min() >= 0.0
    assert scores.max() <= 1.0
    assert model.model_version == card["model_version"]


def test_vector_orders_features_and_rejects_a_missing_one() -> None:
    """Serving builds a feature dict; a silently reordered vector is the bug."""
    model = load_model_a()
    features = {name: float(position) for position, name in enumerate(model.feature_names)}

    vector = model.vector(features)
    assert vector.shape == (1, len(model.feature_names))
    np.testing.assert_allclose(vector[0], np.arange(len(model.feature_names), dtype=float))

    del features[model.feature_names[0]]
    with pytest.raises(KeyError, match=model.feature_names[0]):
        model.vector(features)


# -- the definition of done, asserted ---------------------------------------


def test_committed_card_beats_both_baselines_on_test() -> None:
    """M13's bar. The margins are read from the card, the bar from M12's file."""
    card = _card()
    baselines = json.loads(BASELINES_JSON.read_text())
    comparison = card["comparison_to_baselines"]

    assert comparison["measured_on"] == "test"
    assert comparison["beats_all_baselines"] is True
    assert set(comparison["against"]) == set(baselines["baselines"])

    for key, entry in comparison["against"].items():
        committed_bar = baselines["baselines"][key]["metrics"]["test"]["pr_auc"]
        assert entry["baseline_test_pr_auc"] == committed_bar, (
            f"{key}: the card's bar drifted from baselines.json"
        )
        assert entry["pr_auc_margin"] > 0.0, key


def test_committed_card_meets_the_stated_goal() -> None:
    """Catch >= 80% of doomed listings at <= 25% false-alarm rate, on test."""
    goal = _card()["goal_check"]

    assert goal["threshold_chosen_on"] == "val_op"
    assert goal["checked_on"] == "test"
    assert goal["recall"] >= goal["recall_target"]
    assert goal["false_alarm_rate"] <= goal["false_alarm_rate_limit"]
    assert goal["goal_met"] is True


def test_committed_card_reports_calibration() -> None:
    """Brier and a reliability curve exist only if the scores are probabilities."""
    test = _card()["metrics"]["test"]

    assert test["calibrated_scale"] is True
    assert test["brier"] is not None
    assert len(test["reliability"]) >= 5

    # Every populated bin should sit near the diagonal. Loose on purpose: this
    # is a guard against a calibrator that stopped being applied, not a
    # re-derivation of the Brier score.
    for entry in test["reliability"]:
        assert abs(entry["mean_score"] - entry["observed_rate"]) < 0.15, entry


def test_card_carries_the_simulated_disclaimer_and_no_timestamp() -> None:
    """Two separate promises the card makes about itself.

    The disclaimer, because Spec §9 forbids a simulated figure ever reading as
    real traffic. No timestamp, because the card is committed and diffed and
    `make model` regenerating it byte-stably is the milestone's pass condition —
    a generated-at field would make every rerun a diff.
    """
    raw = (MODEL_DIR / CARD_FILE).read_text()
    card = json.loads(raw)

    assert "SIMULATED" in card["what_this_is"]
    assert any("SIMULATED" in item for item in card["limitations"])

    for banned in ("generated_at", "created_at", "trained_at", "timestamp"):
        assert banned not in raw, f"{banned} would break byte-stable regeneration"


def test_shap_summary_agrees_with_the_card() -> None:
    summary = json.loads((MODEL_DIR / SHAP_FILE).read_text())
    card = _card()

    assert summary["additivity_max_gap"] < 1e-6
    assert [entry["feature"] for entry in summary["features"][:5]] == [
        entry["feature"] for entry in card["shap_top_features"]
    ]
    # Every model feature is attributed, not just the ones that made the table.
    assert len(summary["features"]) == card["dataset"]["n_features"]


# -- the expensive one ------------------------------------------------------


@needs_postgres
def test_committed_card_metrics_match_a_recomputation() -> None:
    """The committed artifact still produces the committed numbers.

    Scores the corpus with the **committed** bundle rather than retraining, so
    this stays a few seconds rather than a few minutes. It catches the failure
    that matters: the model file and the card drifting apart. Retraining from
    scratch is `make model`, and CI runs that separately.
    """
    from ml.db import connect
    from ml.eval.harness import evaluate_across_splits, round_floats
    from ml.features.writer import load_matrix
    from ml.model.dataset import build_dataset

    card = _card()

    with connect() as conn:
        present = conn.execute(
            "select to_regclass('public.events'), to_regclass('public.features_waste')"
        ).fetchone()
        assert present is not None
        if present[0] is None or present[1] is None:
            pytest.skip("no corpus in this database; run `make reproduce`")
        matrix = load_matrix(conn)

    if (
        len(matrix)
        != card["splits"]["train"]["rows"]
        + card["splits"]["val"]["rows"]
        + (card["splits"]["test"]["rows"])
    ):
        pytest.skip(
            f"database holds {len(matrix)} feature rows, which is not the corpus the "
            "model card describes. Run `make reproduce && make model`."
        )

    model = load_model_a()
    dataset = build_dataset(matrix)

    def score(_: Any, split: str) -> np.ndarray:
        return model.score(dataset.x[matrix.mask(split)])

    recomputed = round_floats(
        evaluate_across_splits(matrix, score, card["goal_check"]["recall_target"])
    )
    for split in ("train", "val", "test"):
        for metric in ("pr_auc", "roc_auc", "brier", "base_rate", "n"):
            got, want = recomputed[split][metric], card["metrics"][split][metric]
            assert got == want, f"{split}/{metric}: recomputed {got} vs committed {want}"
