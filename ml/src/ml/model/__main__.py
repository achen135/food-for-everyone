"""CLI: `python -m ml.model` — train, calibrate, evaluate and write the bundle.

The order below is the whole discipline of the milestone, so it is worth reading
as a sequence rather than as steps:

1. Load the corpus fingerprint and the feature matrix.
2. Divide `val` into `val_fit` and `val_op` (`ml.model.dataset`).
3. Search hyperparameters on **`val_fit`** (`ml.model.search`).
4. Fit the calibrator on **`val_fit`**.
5. Place both tier boundaries on **`val_op`** — rows that did not define the
   score scale.
6. Only now read **`test`**, once, to report what all of that cost.

Nothing after step 5 changes anything. If the numbers from step 6 are
disappointing, the honest move is to report them, not to walk back up the list.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ml.corpus import corpus_fingerprint
from ml.db import connect
from ml.eval.harness import evaluate_across_splits, round_floats, split_sizes
from ml.eval.metrics import DEFAULT_RECALL_TARGET
from ml.features.writer import FeatureMatrix, load_matrix
from ml.model.artifact import (
    CARD_FILE,
    MODEL_DIR,
    SHAP_FILE,
    ModelA,
    compute_model_version,
    load_model_a,
    save_bundle,
)
from ml.model.calibrate import choose_operating_points, fit_calibrator
from ml.model.card import baseline_comparison, build_card, goal_check, tier_report
from ml.model.dataset import build_dataset
from ml.model.explain import shap_summary
from ml.model.search import SEARCH_GRID, run_search

BASELINES_PATH = Path(__file__).resolve().parents[3] / "baselines.json"


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ml.model",
        description="Train Model A, calibrate it, evaluate it and write ml/model/.",
    )
    parser.add_argument("--dsn", default=None, help="Corpus DSN. Defaults to $ML_DATABASE_URL.")
    parser.add_argument("--output-dir", default=str(MODEL_DIR))
    parser.add_argument("--recall-target", type=float, default=DEFAULT_RECALL_TARGET)
    parser.add_argument(
        "--baselines", default=str(BASELINES_PATH), help="The committed bar to compare against."
    )
    return parser.parse_args(argv)


def _score_fn(
    model: ModelA, x: np.ndarray, matrix: FeatureMatrix
) -> Callable[[FeatureMatrix, str], np.ndarray]:
    """Adapt the loaded model to the shared eval harness.

    The harness measures every scorer the same way on the same rows — the
    baselines went through it in M12 — so Model A is compared apples to apples
    rather than through its own reporting code.
    """

    def score(_: FeatureMatrix, split: str) -> np.ndarray:
        return model.score(x[matrix.mask(split)])

    return score


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    output_dir = Path(args.output_dir)

    with connect(args.dsn) as conn:
        corpus = corpus_fingerprint(conn)
        matrix = load_matrix(conn)

    if len(matrix) == 0:
        print("features_waste is empty — run `make features` first", file=sys.stderr)
        return 1

    dataset = build_dataset(matrix)
    print(
        f"{len(matrix):,} rows, {len(dataset.feature_names)} features; "
        f"val_fit {int(dataset.val_fit.sum()):,} / val_op {int(dataset.val_op.sum()):,} "
        f"({dataset.val_purged:,} listings purged at the cut)",
        file=sys.stderr,
    )

    # -- 3. Search, on val_fit only.
    search = run_search(dataset)
    winner = ", ".join(f"{key}={search.params[key]}" for key in SEARCH_GRID)
    print(
        f"search: {len(search.trials)} configurations, winner {winner} "
        f"@ {search.best_iteration} rounds, val_fit PR-AUC {search.best_score:.4f}",
        file=sys.stderr,
    )

    # -- 4. Calibrate, on val_fit.
    raw_fit = np.asarray(
        search.booster.predict(dataset.x[dataset.val_fit], num_iteration=search.best_iteration),
        dtype=np.float64,
    )
    calibrator = fit_calibrator(raw_fit, dataset.y[dataset.val_fit])

    # -- 5. Operating points, on val_op.
    raw_op = np.asarray(
        search.booster.predict(dataset.x[dataset.val_op], num_iteration=search.best_iteration),
        dtype=np.float64,
    )
    scores_op = calibrator.apply(raw_op)
    points = choose_operating_points(scores_op, dataset.y[dataset.val_op], args.recall_target)

    model_version = compute_model_version(
        corpus, dataset.feature_names, search.params, search.best_iteration
    )
    save_bundle(
        output_dir,
        search.booster,
        search.best_iteration,
        calibrator,
        points,
        dataset.feature_names,
        model_version,
    )

    # Reload from disk rather than scoring with the in-memory booster: it is the
    # committed artifact that has to produce these numbers, and a bundle that
    # fails to round-trip should fail here rather than in the serving half.
    model = load_model_a(output_dir)

    # -- 6. Test, once.
    metrics = evaluate_across_splits(
        matrix, _score_fn(model, dataset.x, matrix), args.recall_target
    )
    test_mask = matrix.mask("test")
    scores_test = model.score(dataset.x[test_mask])
    y_test = dataset.y[test_mask]

    goal = goal_check(y_test, scores_test, points.threshold_high, args.recall_target)
    comparison = baseline_comparison(Path(args.baselines), metrics["test"])
    tiers = [
        tier_report(dataset.y[dataset.val_op], model.tier(scores_op), "val_op"),
        tier_report(y_test, model.tier(scores_test), "test"),
    ]

    shap = shap_summary(
        search.booster,
        dataset.x[matrix.mask("val")],
        dataset.feature_names,
        search.best_iteration,
        "val",
    )

    card = build_card(
        model_version=model_version,
        corpus=corpus,
        dataset=dataset.describe(),
        splits=split_sizes(matrix),
        search=search.describe(),
        calibration={
            "method": calibrator.method,
            "fitted_on": "val_fit",
            "n_knots": int(calibrator.x.size),
            "knots_committed_in": "model_a.json",
            "why": (
                "chosen up front rather than by comparing methods on the calibration "
                "set, which would be circular; see ml/src/ml/model/calibrate.py"
            ),
        },
        operating_points=points.describe(),
        metrics=metrics,
        comparison=comparison,
        goal=goal,
        tiers=tiers,
        shap_top=shap["features"][:5],
    )

    (output_dir / CARD_FILE).write_text(
        json.dumps(round_floats(card), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / SHAP_FILE).write_text(
        json.dumps(round_floats(shap), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    _report(model_version, metrics, comparison, goal, shap, output_dir)
    return 0


def _report(
    model_version: str,
    metrics: dict[str, Any],
    comparison: dict[str, Any],
    goal: dict[str, Any],
    shap: dict[str, Any],
    output_dir: Path,
) -> None:
    test = metrics["test"]
    lines = [
        "",
        f"model_version       {model_version}",
        f"wrote               {output_dir}",
        "",
        f"test PR-AUC         {test['pr_auc']:.4f}   (base rate {test['base_rate']:.4f}, "
        f"lift {test['lift_over_base']:.2f}x)",
        f"test ROC-AUC        {test['roc_auc']:.4f}",
        f"test Brier          {test['brier']:.4f}",
        f"train PR-AUC        {metrics['train']['pr_auc']:.4f}"
        f"   (train-test gap {metrics['train']['pr_auc'] - test['pr_auc']:+.4f})",
        "",
        "versus the committed baselines, on test:",
    ]
    for key, entry in comparison["against"].items():
        verdict = "BEATS" if entry["beats"] else "DOES NOT BEAT"
        lines.append(
            f"  {key:20s} {entry['baseline_test_pr_auc']:.4f} -> {entry['model_test_pr_auc']:.4f}"
            f"  {verdict} by {entry['pr_auc_margin']:+.4f} PR-AUC"
            f"  ({entry['pr_auc_relative_gain']:+.1%})"
        )
    lines += [
        "",
        f"goal ({goal['stated_goal']})",
        f"  recall            {goal['recall']:.4f}  {'MET' if goal['recall_met'] else 'NOT MET'}",
        f"  false-alarm rate  {goal['false_alarm_rate']:.4f}  "
        f"{'MET' if goal['false_alarm_rate_met'] else 'NOT MET'}",
        f"  precision         {goal['precision']:.4f}",
        "",
        "top features by mean|SHAP|:",
    ]
    lines += [f"  {entry['feature']:32s} {entry['share']:6.1%}" for entry in shap["features"][:5]]
    print("\n".join(lines), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
