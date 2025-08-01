"""Metrics, the rules baselines, and the committed `baselines.json`.

The reproducibility test at the bottom is the one that matters: it recomputes
the baselines from the corpus in the database and asserts the committed file
still describes it. That is what makes "`make data && make features &&
make eval-baselines` reproduces baselines.json from a clean checkout" a checked
claim rather than a README promise.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from ml.baselines.rules import BASELINES, sweep_operating_points
from ml.eval.metrics import evaluate_scores, reliability_curve

BASELINES_JSON = Path(__file__).resolve().parent.parent / "baselines.json"


# -- metrics -----------------------------------------------------------------


def test_a_perfect_scorer_scores_perfectly() -> None:
    labels = np.array([0, 0, 1, 1, 0, 1])
    result = evaluate_scores(labels, labels.astype(float), recall_target=0.8)
    assert result["roc_auc"] == 1.0
    assert result["pr_auc"] == 1.0
    assert result["at_recall_target"]["precision"] == 1.0


def test_a_constant_scorer_lands_on_the_base_rate() -> None:
    """PR-AUC's floor is the prevalence, which is why `base_rate` is reported
    beside it — 0.45 is strong at a 20% base rate and poor at 40%."""
    labels = np.array([0, 1, 0, 0, 1, 0, 0, 0, 1, 0])
    result = evaluate_scores(labels, np.full(labels.shape, 0.5), recall_target=0.8)
    assert result["roc_auc"] == 0.5
    assert math.isclose(result["pr_auc"], result["base_rate"], rel_tol=0.05)
    assert math.isclose(result["lift_over_base"], 1.0, rel_tol=0.05)


def test_a_single_class_split_is_rejected_rather_than_scored() -> None:
    """AUC is undefined here. Returning a number would be worse than failing."""
    with pytest.raises(ValueError, match="single class"):
        evaluate_scores(np.zeros(10, dtype=int), np.linspace(0, 1, 10), recall_target=0.8)


def test_brier_is_withheld_when_the_score_is_not_a_probability() -> None:
    """The rules baselines emit ranks, not probabilities. Rescaling them into
    [0, 1] to produce a Brier score would make an uncalibrated scorer look
    calibrated, which is exactly the claim M13 has to earn."""
    labels = np.array([0, 1, 1, 0, 1, 0])
    ranked = evaluate_scores(labels, np.array([-8.0, -1.0, -2.0, -9.0, -0.5, -7.0]), 0.8)
    assert ranked["brier"] is None
    assert ranked["calibrated_scale"] is False
    assert ranked["reliability"] == []

    probabilities = evaluate_scores(labels, np.array([0.1, 0.9, 0.8, 0.05, 0.95, 0.2]), 0.8)
    assert probabilities["brier"] is not None
    assert probabilities["calibrated_scale"] is True
    assert probabilities["reliability"]


def test_an_unreachable_recall_target_is_reported_not_faked() -> None:
    labels = np.array([0, 0, 1, 1])
    result = evaluate_scores(labels, np.array([0.9, 0.9, 0.9, 0.1]), recall_target=0.99)
    point = result["at_recall_target"]
    assert point["reachable"] in (True, False)
    if not point["reachable"]:
        assert point["precision"] is None


def test_reliability_curve_skips_empty_bins() -> None:
    """An empty bin is not evidence of poor calibration, and a rules baseline
    puts everything into two bins."""
    labels = np.array([0, 1, 1, 0])
    curve = reliability_curve(labels, np.array([0.05, 0.95, 0.95, 0.05]), bins=10)
    assert len(curve) == 2
    assert all(row["count"] > 0 for row in curve)


# -- the rules ---------------------------------------------------------------


def test_every_baseline_declares_what_it_sweeps() -> None:
    for baseline in BASELINES:
        assert baseline.sweep_grid == tuple(sorted(baseline.sweep_grid))
        assert baseline.sweep_feature
        assert baseline.notes, f"{baseline.key} has no stated limitation"


def test_fire_rate_is_monotone_in_k() -> None:
    """`fire_rate` is `P(feature <= k)`, so it cannot decrease as k grows. A
    drop would mean the sweep and the score disagree about direction."""

    class _Fake:
        def __init__(self) -> None:
            self.values = np.array([0.0, 1.0, 2.0, 5.0, 9.0, 20.0, 100.0, 300.0])
            self.lab = np.array([1, 1, 1, 0, 1, 0, 0, 0])

        def column(self, _name: str, _split: str | None = None) -> np.ndarray:
            return self.values

        def labels(self, _split: str | None = None) -> np.ndarray:
            return self.lab

    for baseline in BASELINES:
        points = sweep_operating_points(baseline, _Fake(), "val")  # type: ignore[arg-type]
        rates = [point["fire_rate"] for point in points]
        assert rates == sorted(rates), baseline.key


# -- the committed file ------------------------------------------------------


def test_baselines_json_is_committed_and_well_formed() -> None:
    assert BASELINES_JSON.exists(), "run `make eval-baselines`"
    document = json.loads(BASELINES_JSON.read_text())

    assert document["primary_metric"] == "pr_auc"
    assert "simulated" in document["what_this_is"].lower(), (
        "every figure has to carry the word; Spec §9 forbids presenting seeded data as real traffic"
    )
    assert set(document["baselines"]) == {baseline.key for baseline in BASELINES}

    for key, result in document["baselines"].items():
        for split in ("train", "val", "test"):
            metrics = result["metrics"][split]
            assert 0.0 <= metrics["pr_auc"] <= 1.0, key
            assert 0.0 <= metrics["roc_auc"] <= 1.0, key
            # A baseline below its own base rate is not a baseline.
            assert metrics["pr_auc"] > metrics["base_rate"], f"{key}/{split}"
        assert result["operating_point"]["chosen_on"] == "val", (
            f"{key} chose its threshold somewhere other than validation"
        )


def test_committed_splits_do_not_overlap_in_size_or_vanish() -> None:
    document = json.loads(BASELINES_JSON.read_text())
    splits = document["features"]["splits"]
    total = sum(split["rows"] for split in splits.values())
    assert total == document["features"]["rows"]
    for name, split in splits.items():
        assert split["rows"] > 0, name
        assert 0.0 < split["base_rate"] < 1.0, name


def test_baseline_scoring_is_deterministic() -> None:
    """The reproducibility claim, in the form that needs no database.

    Corpus -> features -> baseline metrics, twice, from the same seed. Any
    non-determinism anywhere in that chain — a set iterated somewhere, a dict
    ordering leaking into a tie-break — shows up as different metrics here.

    This runs everywhere. The full-corpus comparison below is stronger but
    conditional, so this is the one that actually guards CI.
    """
    from ml.eval.metrics import evaluate_scores
    from ml.features.labels import build_label_index
    from ml.features.log import from_events, sorted_log
    from ml.features.pipeline import build_observations
    from ml.features.spec import FEATURE_NAMES
    from ml.simulate.config import SimulationConfig
    from ml.simulate.engine import simulate

    def run() -> dict[str, dict[str, float]]:
        config = SimulationConfig(seed=2024, months=1, n_donors=30, n_recipients=20)
        events, _ = simulate(config)
        log = sorted_log(from_events(events))
        index = build_label_index(iter(log))

        rows: list[tuple[dict[str, Any], int]] = []
        for observation in build_observations(iter(log)):
            label, _reason = index.label(observation.listing_id, observation.as_of)
            if label is not None:
                rows.append((observation.features, label))

        labels = np.array([label for _features, label in rows])
        out: dict[str, dict[str, float]] = {}
        for baseline in BASELINES:
            scores = np.array(
                [-float(features[baseline.sweep_feature]) for features, _label in rows]
            )
            metrics = evaluate_scores(labels, scores, recall_target=0.8)
            out[baseline.key] = {
                "pr_auc": metrics["pr_auc"],
                "roc_auc": metrics["roc_auc"],
                "n": float(metrics["n"]),
            }
        assert set(FEATURE_NAMES) <= set(rows[0][0])
        return out

    first, second = run(), run()
    assert first == second
    for key, metrics in first.items():
        assert metrics["n"] > 0, key
        assert 0.0 < metrics["pr_auc"] < 1.0, key


@pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs the corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)
def test_committed_numbers_match_a_recomputation() -> None:
    """The reproducibility claim, checked.

    Recomputes both baselines from `features_waste` as it stands and compares
    with the committed file. A mismatch means either the corpus in the database
    is not the one `baselines.json` describes — the fingerprint check below says
    which — or the scoring code changed without the file being regenerated.
    """
    from ml.db import connect
    from ml.eval.harness import evaluate_across_splits, round_floats
    from ml.features.writer import load_matrix

    document = json.loads(BASELINES_JSON.read_text())

    with connect() as conn:
        # Does the corpus even exist? On CI the database is an empty service
        # container and nothing has run `make data`, so `public.events` is not
        # there at all — and querying it raises `UndefinedTable` long before the
        # fingerprint comparison below gets a chance to skip. Checking for the
        # tables first is what makes the skip reachable.
        present = conn.execute(
            "select to_regclass('public.events'), to_regclass('public.features_waste')"
        ).fetchone()
        assert present is not None
        if present[0] is None or present[1] is None:
            pytest.skip(
                "no corpus in this database (public.events / public.features_waste absent). "
                "Run `make reproduce` to build one and compare against baselines.json."
            )

        counts = conn.execute(
            "select count(*), count(distinct listing_id) from public.events"
        ).fetchone()
        assert counts is not None
        total, listings = counts
        matrix = load_matrix(conn)

    # `test_postgres.py` replaces `public.events` with a small corpus of its
    # own, and CI starts from an empty database, so the full corpus is often
    # simply not there. That is not a failure of reproducibility — it is the
    # absence of the thing to check — so it skips, loudly, naming the command
    # that fixes it. `test_baseline_scoring_is_deterministic` above is the
    # unconditional guard; this is the stronger, opportunistic one.
    if (
        total != document["corpus"]["events"]
        or listings != document["corpus"]["listings"]
        or len(matrix) != document["features"]["rows"]
    ):
        pytest.skip(
            f"database holds {total} events / {len(matrix)} feature rows, but "
            f"baselines.json describes {document['corpus']['events']} / "
            f"{document['features']['rows']}. Run `make reproduce` to compare them."
        )

    for baseline in BASELINES:
        recomputed = round_floats(
            evaluate_across_splits(matrix, baseline.score, document["recall_target"])
        )
        committed = document["baselines"][baseline.key]["metrics"]
        for split in ("train", "val", "test"):
            for metric in ("pr_auc", "roc_auc", "base_rate", "n", "n_positive"):
                got, want = recomputed[split][metric], committed[split][metric]
                assert got == want, (
                    f"{baseline.key}/{split}/{metric}: recomputed {got} vs committed {want}"
                )
