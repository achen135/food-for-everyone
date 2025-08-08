"""CLI: `python -m ml.baselines` — measure the rules baselines, write baselines.json.

## What touches which split

- **Validation** chooses each rule's operating point `k`. Nothing else does.
- **Train** is reported for completeness; nothing is fitted, since these are
  rules with no parameters beyond `k`.
- **Test** is measured **once, here, before any model exists**, and committed.

That last one deserves stating plainly, because "the test split stays untouched"
can be read as "never look at it in M12". The stronger guarantee is the one
taken here: the bar M13 has to clear is computed and written down *before* the
thing being measured is built, so it cannot be quietly moved afterwards. What
must not happen is *selecting* on test, and nothing here does — the only choice
made is `k`, and it is made on validation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ml.baselines.rules import BASELINES, Baseline, sweep_operating_points
from ml.corpus import corpus_fingerprint
from ml.db import connect
from ml.eval.harness import evaluate_across_splits, round_floats, split_sizes
from ml.eval.metrics import DEFAULT_RECALL_TARGET
from ml.eval.splits import TRAIN_FRACTION, VAL_FRACTION
from ml.features.spec import OBSERVATION_INTERVAL_HOURS
from ml.features.writer import FeatureMatrix, load_matrix

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent.parent.parent / "baselines.json"


#: An operating point that fires on more than this share of observations is
#: degenerate — "flag everything" has recall 1.0 by construction and precision
#: equal to the base rate, and reporting it as a baseline's chosen point would
#: overstate what the rule can do while looking like it hit the target.
#:
#: This is not hypothetical. The recipient-scarcity rule reaches recall 0.8 on
#: this corpus only at k = 350, which fires on 99.2% of rows at precision 0.462
#: against a 0.461 base rate. Excluding that, the honest answer is that the rule
#: cannot reach the target at all, and `recall_target_reachable` says so.
MAX_FIRE_RATE: float = 0.90


def _choose_k(baseline: Baseline, matrix: FeatureMatrix, recall_target: float) -> dict[str, Any]:
    """Pick the rule's threshold on **validation**.

    Best precision among the k that reach the recall target without degenerating
    into "flag everything"; if none do, the k with the highest recall that still
    discriminates.
    """
    sweep = sweep_operating_points(baseline, matrix, "val")
    usable = [point for point in sweep if point["fire_rate"] <= MAX_FIRE_RATE]
    if not usable:
        usable = sweep

    reaching = [point for point in usable if point["recall"] >= recall_target]
    if reaching:
        chosen = max(reaching, key=lambda point: point["precision"])
        basis = f"highest precision among k reaching recall >= {recall_target}"
        reachable = True
    else:
        chosen = max(usable, key=lambda point: point["recall"])
        basis = (
            f"no k reaches recall >= {recall_target} without firing on more than "
            f"{MAX_FIRE_RATE:.0%} of observations; reporting the highest-recall k "
            "that still discriminates"
        )
        reachable = False
    return {
        "chosen": chosen,
        "basis": basis,
        "sweep": sweep,
        "recall_target_reachable": reachable,
        "max_fire_rate": MAX_FIRE_RATE,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ml.baselines",
        description="Measure the rules baselines and write baselines.json.",
    )
    parser.add_argument("--dsn", default=None)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--recall-target", type=float, default=DEFAULT_RECALL_TARGET)
    args = parser.parse_args(argv)

    with connect(args.dsn) as conn:
        fingerprint = corpus_fingerprint(conn)
        matrix = load_matrix(conn)

    if len(matrix) == 0:
        print("features_waste is empty — run `make features` first", file=sys.stderr)
        return 1

    sizes = split_sizes(matrix)
    results: dict[str, Any] = {}

    for baseline in BASELINES:
        selection = _choose_k(baseline, matrix, args.recall_target)
        results[baseline.key] = {
            "name": baseline.name,
            "rule": baseline.rule,
            "notes": baseline.notes,
            "operating_point": {
                "chosen_on": "val",
                "sweep_feature": baseline.sweep_feature,
                "sweep_label": baseline.sweep_label,
                "basis": selection["basis"],
                "recall_target_reachable": selection["recall_target_reachable"],
                "max_fire_rate": selection["max_fire_rate"],
                "k": selection["chosen"]["k"],
                "val_precision": selection["chosen"]["precision"],
                "val_recall": selection["chosen"]["recall"],
                "val_fire_rate": selection["chosen"]["fire_rate"],
                "sweep": selection["sweep"],
            },
            "metrics": evaluate_across_splits(matrix, baseline.score, args.recall_target),
        }

    document = round_floats(
        {
            "generated_by": "python -m ml.baselines",
            "what_this_is": (
                "Rules baselines for Model A (will this open listing expire unclaimed?), "
                "measured on a SIMULATED corpus. Every figure here describes the generator "
                "documented in ml/docs/simulator.md, not real donation behaviour."
            ),
            "primary_metric": "pr_auc",
            "recall_target": args.recall_target,
            "corpus": fingerprint,
            "features": {
                "rows": len(matrix),
                "observation_interval_hours": OBSERVATION_INTERVAL_HOURS,
                "split_fractions": {
                    "train": TRAIN_FRACTION,
                    "val": VAL_FRACTION,
                    "test": round(1.0 - TRAIN_FRACTION - VAL_FRACTION, 6),
                },
                "splits": sizes,
            },
            "baselines": results,
        }
    )

    output = Path(args.output)
    output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"wrote {output}", file=sys.stderr)
    for key, result in results.items():
        test = result["metrics"]["test"]
        print(
            f"  {key:20s} test PR-AUC {test['pr_auc']:.4f}"
            f"  ROC-AUC {test['roc_auc']:.4f}"
            f"  base {test['base_rate']:.4f}"
            f"  lift {test['lift_over_base']:.2f}x",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
