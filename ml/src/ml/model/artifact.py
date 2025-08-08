"""The committed model bundle: what is on disk, and how it is loaded.

## What gets committed, and why

Four files in `ml/model/`:

| file | what it is |
|---|---|
| `model_a.txt` | the booster, LightGBM's own text format |
| `model_a.json` | everything the serving path needs *besides* the trees |
| `model_card.json` | the audit record — params, search, metrics, caveats |
| `shap_summary.json` | per-feature attribution |

The artifact is committed rather than regenerated on demand. It is small, it
makes the serving path and its tests deterministic without a training step in
front of them, and `make model` is the reproducer if anyone doubts it.

**Text formats throughout, and no pickle anywhere.** A pickled booster or a
pickled `IsotonicRegression` would bind the committed artifact to the exact
library versions that wrote it, and would mean the serving process loads
executable state from a file. LightGBM's text format and a JSON list of isotonic
knots carry the same information, diff readably, and load into any compatible
version.

## `model_version`

Derived, not typed by hand — a version someone has to remember to bump is a
version that silently goes stale. It is a digest over everything that determines
the model: the corpus fingerprint, the feature list, the winning parameters and
the stopping iteration. Two runs that would produce the same model produce the
same version, and any change that matters produces a different one.

It is deliberately **not** a hash of `model_a.txt`. The booster file is not
promised to be byte-identical across platforms (floating-point histogram
construction), so hashing it would make `model_version` — which lands in every
`predictions` row and in the model card — vary by machine while describing an
identical model.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np

from ml.model.calibrate import Calibrator, OperatingPoints

__all__ = [
    "BOOSTER_FILE",
    "CARD_FILE",
    "MODEL_DIR",
    "MODEL_DIR_ENV",
    "RUNTIME_FILE",
    "SHAP_FILE",
    "ModelA",
    "compute_model_version",
    "load_model_a",
    "resolve_model_dir",
    "save_bundle",
]

#: Where the committed bundle lives.
#:
#: `parents[3]` walks `src/ml/model/artifact.py` back up to `ml/`, which is
#: right for a source checkout and **wrong once the package is installed**: in
#: the container the module sits in `site-packages/ml/model/`, so the same walk
#: lands on `/usr/local/lib/python3.12/model` and the service dies at import.
#: Only a real image build surfaces that — an editable install never does.
#:
#: So the path is configurable and the Dockerfile sets it, and
#: `resolve_model_dir` reports what it tried rather than letting a bare
#: FileNotFoundError surface three frames deep inside `json.loads`.
MODEL_DIR = Path(__file__).resolve().parents[3] / "model"
MODEL_DIR_ENV = "ML_MODEL_DIR"
BOOSTER_FILE = "model_a.txt"
RUNTIME_FILE = "model_a.json"
CARD_FILE = "model_card.json"
SHAP_FILE = "shap_summary.json"


def compute_model_version(
    corpus: dict[str, Any], feature_names: list[str], params: dict[str, Any], best_iteration: int
) -> str:
    """`model_a-v1-<8 hex>`, stable across machines that would train the same model."""
    payload = json.dumps(
        {
            "corpus": corpus,
            "features": feature_names,
            "params": dict(sorted(params.items())),
            "best_iteration": best_iteration,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.blake2b(payload.encode("utf-8"), digest_size=4).hexdigest()
    return f"model_a-v1-{digest}"


@dataclass(frozen=True, slots=True)
class ModelA:
    """The loaded model: booster, calibrator and the tier boundaries.

    One object so that every consumer — the eval harness, the serving endpoint,
    M14's batch scorer — produces the *same* number for the same features. The
    training/serving skew this subsystem worries about starts with two code
    paths that each apply "the model" slightly differently.
    """

    booster: lgb.Booster
    calibrator: Calibrator
    operating_points: OperatingPoints
    feature_names: list[str]
    model_version: str
    best_iteration: int

    def raw(self, x: np.ndarray) -> np.ndarray:
        return np.asarray(
            self.booster.predict(x, num_iteration=self.best_iteration), dtype=np.float64
        )

    def score(self, x: np.ndarray) -> np.ndarray:
        """Calibrated probability that these listings expire unclaimed."""
        return self.calibrator.apply(self.raw(x))

    def tier(self, scores: np.ndarray) -> np.ndarray:
        return self.operating_points.tiers(scores)

    def vector(self, features: dict[str, Any]) -> np.ndarray:
        """One feature dict to a 1 x n array, in the model's own column order.

        The order is the model's, not the caller's. Serving builds features from
        a dict and a silently reordered vector is the exact failure
        `features_hash` exists to catch — better to raise here on a missing key.
        """
        missing = [name for name in self.feature_names if name not in features]
        if missing:
            raise KeyError(f"missing features: {', '.join(missing)}")
        row = [
            float("nan") if features[name] is None else float(features[name])
            for name in self.feature_names
        ]
        return np.asarray([row], dtype=np.float64)


def save_bundle(
    directory: Path,
    booster: lgb.Booster,
    best_iteration: int,
    calibrator: Calibrator,
    operating_points: OperatingPoints,
    feature_names: list[str],
    model_version: str,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(directory / BOOSTER_FILE), num_iteration=best_iteration)
    runtime = {
        "model_version": model_version,
        "best_iteration": best_iteration,
        "feature_names": list(feature_names),
        "calibrator": calibrator.to_json(),
        "operating_points": {
            "threshold_high": operating_points.threshold_high,
            "threshold_low": operating_points.threshold_low,
            "recall_target": operating_points.recall_target,
        },
    }
    (directory / RUNTIME_FILE).write_text(
        json.dumps(runtime, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def resolve_model_dir(directory: Path | None = None) -> Path:
    """Explicit argument, then `$ML_MODEL_DIR`, then the source-tree default."""
    if directory is not None:
        return directory
    configured = os.environ.get(MODEL_DIR_ENV)
    if configured:
        return Path(configured)
    return MODEL_DIR


def load_model_a(directory: Path | None = None) -> ModelA:
    """Load the committed bundle. Used by evaluation, serving and M14 alike."""
    directory = resolve_model_dir(directory)
    if not (directory / RUNTIME_FILE).exists():
        raise FileNotFoundError(
            f"no model bundle at {directory} (looked for {RUNTIME_FILE}). "
            f"Run `make model` to train one, or set ${MODEL_DIR_ENV} to where it lives."
        )
    runtime = json.loads((directory / RUNTIME_FILE).read_text(encoding="utf-8"))
    points = runtime["operating_points"]
    return ModelA(
        booster=lgb.Booster(model_file=str(directory / BOOSTER_FILE)),
        calibrator=Calibrator.from_json(runtime["calibrator"]),
        operating_points=OperatingPoints(
            threshold_high=float(points["threshold_high"]),
            threshold_low=float(points["threshold_low"]),
            recall_target=float(points["recall_target"]),
            # Reporting fields; the committed record of what they cost is the
            # model card, which is not loaded at serving time.
            val_op_precision=None,
            val_op_recall=None,
            val_op_base_rate=float(points["threshold_low"]),
            recall_target_reachable=True,
        ),
        feature_names=list(runtime["feature_names"]),
        model_version=str(runtime["model_version"]),
        best_iteration=int(runtime["best_iteration"]),
    )
