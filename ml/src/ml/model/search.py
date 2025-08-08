"""Hyperparameter search — bounded, deterministic, and never on `test`.

## What each split is allowed to do here

- **`train`** fits every candidate booster. Nothing is selected on it.
- **`val_fit`** scores the candidates and picks the boosting round to stop at.
  It is the only thing that chooses.
- **`val_op`** is untouched by this module. It exists so the operating threshold
  is placed on rows that did not define the score scale (`calibrate`).
- **`test`** is not read. `ml/baselines.json` fixed the bar M13 has to clear
  before this model existed, and selecting on `test` would quietly move it.

## Why a grid rather than Optuna

The brief allows either. A grid of 18 points is fully enumerable, reproduces
exactly without a study database or a sampler seed to get wrong, and — on a
corpus where the top two features carry over half the gain — the search is
worth about 0.002 PR-AUC either way. Optuna would be more machinery for a
decision this insensitive, and the whole table lands in the model card so the
search can be read rather than trusted.

## Class balance is left alone, on purpose

The obvious move on an imbalanced problem is `is_unbalance` or
`scale_pos_weight`. Neither is set here, because **this problem is not
imbalanced at the observation level**: 45.7% of rows are positive. Reweighting a
near-balanced problem does nothing useful and actively distorts the output
probabilities, which the next step has to calibrate. The 24.8% figure that makes
the problem *look* imbalanced is per *listing*, and listings are not what is
scored — see `docs/ML Subsystem.md` §6 on not mixing the two base rates.

## Determinism

`deterministic=true` with `force_row_wise=true` is LightGBM's documented
combination for results that do not move with thread count, and every seed it
consumes is pinned. The booster file is still not promised to be byte-identical
across platforms — histogram construction is floating-point — so the check that
actually matters is that the **model card's numbers** regenerate, which
`round_floats` makes robust to the last few decimal places.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Any, Final

import lightgbm as lgb
import numpy as np

from ml.model.dataset import ModelDataset

__all__ = ["BASE_PARAMS", "MAX_ROUNDS", "SEARCH_GRID", "SearchResult", "run_search"]

SEED: Final[int] = 20250808

#: Pinned rather than left to the machine. A fixed thread count is not required
#: for reproducibility once `deterministic` is on, but it removes the one knob
#: most likely to differ between this laptop and a CI runner.
NUM_THREADS: Final[int] = 4

MAX_ROUNDS: Final[int] = 500

BASE_PARAMS: Final[dict[str, Any]] = {
    "objective": "binary",
    "metric": "average_precision",
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "feature_fraction": 0.9,
    "verbosity": -1,
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": NUM_THREADS,
    "seed": SEED,
    "bagging_seed": SEED,
    "feature_fraction_seed": SEED,
    "data_random_seed": SEED,
}

#: 2 x 3 x 3 = 18 configurations. Enumerated in this order, and ties are broken
#: by it, so the winner does not depend on dict ordering anywhere.
SEARCH_GRID: Final[dict[str, tuple[Any, ...]]] = {
    "learning_rate": (0.05, 0.1),
    "num_leaves": (31, 63, 127),
    "min_data_in_leaf": (50, 200, 500),
}


@dataclass(frozen=True, slots=True)
class SearchResult:
    booster: lgb.Booster
    params: dict[str, Any]
    best_iteration: int
    best_score: float
    trials: list[dict[str, Any]]

    def describe(self) -> dict[str, Any]:
        return {
            "method": "exhaustive grid",
            "selected_on": "val_fit",
            "objective": "average_precision (PR-AUC)",
            "max_rounds": MAX_ROUNDS,
            "seed": SEED,
            "num_threads": NUM_THREADS,
            "space": {key: list(values) for key, values in SEARCH_GRID.items()},
            "n_trials": len(self.trials),
            "base_params": dict(BASE_PARAMS),
            "winner": {
                "params": {key: self.params[key] for key in SEARCH_GRID},
                "best_iteration": self.best_iteration,
                "val_fit_pr_auc": self.best_score,
            },
            "trials": self.trials,
        }


def _configurations() -> list[dict[str, Any]]:
    keys = list(SEARCH_GRID)
    return [
        dict(zip(keys, values, strict=True))
        for values in itertools.product(*(SEARCH_GRID[key] for key in keys))
    ]


def run_search(dataset: ModelDataset) -> SearchResult:
    """Train every configuration on `train`, score each on `val_fit`."""
    x_train, y_train = dataset.slice(dataset.split_mask("train"))
    x_fit, y_fit = dataset.slice(dataset.val_fit)

    train_set = lgb.Dataset(x_train, label=y_train, feature_name=dataset.feature_names)
    fit_set = lgb.Dataset(x_fit, label=y_fit, reference=train_set)

    best: SearchResult | None = None
    trials: list[dict[str, Any]] = []

    for config in _configurations():
        params = {**BASE_PARAMS, **config}
        history: dict[str, dict[str, list[float]]] = {}
        booster = lgb.train(
            params,
            train_set,
            num_boost_round=MAX_ROUNDS,
            valid_sets=[fit_set],
            valid_names=["val_fit"],
            callbacks=[lgb.record_evaluation(history)],
        )
        curve = history["val_fit"]["average_precision"]
        # `+ 1` because LightGBM counts iterations from one, and the artifact is
        # later truncated with `num_iteration=best_iteration`.
        best_iteration = int(np.argmax(curve)) + 1
        score = float(curve[best_iteration - 1])

        trials.append({**config, "best_iteration": best_iteration, "val_fit_pr_auc": score})

        # Strictly greater, so the first configuration in grid order wins a tie.
        if best is None or score > best.best_score:
            best = SearchResult(
                booster=booster,
                params=params,
                best_iteration=best_iteration,
                best_score=score,
                trials=trials,
            )

    assert best is not None
    return SearchResult(
        booster=best.booster,
        params=best.params,
        best_iteration=best.best_iteration,
        best_score=best.best_score,
        trials=trials,
    )
