"""The model card — the document that has to survive being read sceptically.

Everything a reader needs to decide whether to believe a number: which corpus,
which rows, which parameters, what was chosen where, what the bar was, and what
the result does *not* mean.

## No timestamps in here

The card is committed and diffed, and `make model` regenerating it byte-stably
is M13's stated pass condition. A `generated_at` field would make every rerun a
diff and the check worthless. What identifies a run is `model_version` and the
corpus fingerprint — both derived from inputs, both stable — not the wall clock.
Same discipline as `baselines.json`, and the same reason.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

__all__ = ["baseline_comparison", "build_card", "goal_check", "tier_report"]


def baseline_comparison(baselines_path: Path, test_metrics: dict[str, Any]) -> dict[str, Any]:
    """Margin over each committed baseline, on the split that judges.

    Read from `baselines.json` rather than restated, so the bar cannot be
    transcribed optimistically. M12 committed those test numbers before this
    model existed, which is what stops them moving now.
    """
    document = json.loads(baselines_path.read_text(encoding="utf-8"))
    model_pr_auc = float(test_metrics["pr_auc"])
    model_roc_auc = float(test_metrics["roc_auc"])

    against: dict[str, Any] = {}
    beats_all = True
    for key, baseline in document["baselines"].items():
        test = baseline["metrics"]["test"]
        margin = model_pr_auc - float(test["pr_auc"])
        beats = margin > 0.0
        beats_all = beats_all and beats
        against[key] = {
            "name": baseline["name"],
            "baseline_test_pr_auc": float(test["pr_auc"]),
            "baseline_test_roc_auc": float(test["roc_auc"]),
            "model_test_pr_auc": model_pr_auc,
            "model_test_roc_auc": model_roc_auc,
            "pr_auc_margin": margin,
            "pr_auc_relative_gain": margin / float(test["pr_auc"]),
            "beats": beats,
        }

    return {
        "measured_on": "test",
        "primary_metric": "pr_auc",
        "source": "ml/baselines.json (committed in M12, before this model existed)",
        "beats_all_baselines": beats_all,
        "against": against,
    }


def goal_check(
    y_true: np.ndarray, scores: np.ndarray, threshold_high: float, recall_target: float
) -> dict[str, Any]:
    """§5's goal, checked on `test` at the threshold `val_op` chose.

    "Catch >=80% of doomed listings at <=25% false-alarm rate." The threshold is
    not re-picked here — that would be tuning on test, and the point of the
    check is that the operating point chosen on `val_op` survives contact with
    rows nothing selected on.
    """
    y_true = np.asarray(y_true).astype(int)
    flagged = np.asarray(scores) >= threshold_high

    positives = int(y_true.sum())
    negatives = int((1 - y_true).sum())
    true_positives = int((flagged & (y_true == 1)).sum())
    false_positives = int((flagged & (y_true == 0)).sum())

    recall = true_positives / positives if positives else 0.0
    false_alarm_rate = false_positives / negatives if negatives else 0.0
    precision = true_positives / int(flagged.sum()) if flagged.any() else 0.0

    return {
        "stated_goal": (
            f"catch >= {recall_target:.0%} of doomed listings at <= 25% false-alarm rate (FPR)"
        ),
        "threshold": threshold_high,
        "threshold_chosen_on": "val_op",
        "checked_on": "test",
        "recall": recall,
        "recall_target": recall_target,
        "recall_met": recall >= recall_target,
        "false_alarm_rate": false_alarm_rate,
        "false_alarm_rate_limit": 0.25,
        "false_alarm_rate_met": false_alarm_rate <= 0.25,
        "precision": precision,
        "flagged_share": float(flagged.mean()),
        "goal_met": bool(recall >= recall_target and false_alarm_rate <= 0.25),
    }


def tier_report(y_true: np.ndarray, tiers: np.ndarray, split_name: str) -> dict[str, Any]:
    """How many listings land in each tier, and how often each is right.

    The number that matters to the product is the observed waste rate per tier:
    a `high` tier that is not mostly doomed listings would make every escalation
    noise, and a `low` tier that is not mostly fine would make the quiet ones
    dangerous.
    """
    y_true = np.asarray(y_true).astype(int)
    out: dict[str, Any] = {"split": split_name, "tiers": {}}
    for name in ("low", "medium", "high"):
        in_tier = tiers == name
        count = int(in_tier.sum())
        out["tiers"][name] = {
            "rows": count,
            "share": float(in_tier.mean()),
            "observed_waste_rate": float(y_true[in_tier].mean()) if count else None,
        }
    out["base_rate"] = float(y_true.mean())
    return out


def build_card(
    *,
    model_version: str,
    corpus: dict[str, Any],
    dataset: dict[str, Any],
    splits: dict[str, Any],
    search: dict[str, Any],
    calibration: dict[str, Any],
    operating_points: dict[str, Any],
    metrics: dict[str, dict[str, Any]],
    comparison: dict[str, Any],
    goal: dict[str, Any],
    tiers: list[dict[str, Any]],
    shap_top: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "generated_by": "python -m ml.model",
        "model": "Model A — will this open donation listing expire unclaimed?",
        "model_version": model_version,
        "what_this_is": (
            "A calibrated LightGBM binary classifier scoring OPEN listings hourly, trained "
            "and measured entirely on a SIMULATED event corpus. Every figure in this file "
            "describes the generator documented in ml/docs/simulator.md, not real donation "
            "behaviour. FFE has no real traffic; nothing here may be quoted as if it did."
        ),
        "primary_metric": "pr_auc",
        "algorithm": "LightGBM gradient-boosted trees (binary objective)",
        "corpus": corpus,
        "dataset": dataset,
        "splits": splits,
        "training": search,
        "calibration": calibration,
        "operating_points": operating_points,
        "metrics": metrics,
        "comparison_to_baselines": comparison,
        "goal_check": goal,
        "risk_tiers": tiers,
        "shap_top_features": shap_top,
        "limitations": [
            "SIMULATED DATA. The model can only learn structure the simulator put in. "
            "ml/docs/simulator.md states the assumptions and therefore bounds what any "
            "metric here can claim.",
            "The margin over the time-pressure baseline is large mostly because of one "
            "feature, pickup_end_hour, which carries the largest share of both gain and "
            "mean|SHAP|. The generator decides collection substantially by whether the "
            "pickup window closes while recipients are open, so the model is recovering "
            "the generator's own rule. On real data that rule would be softer and this "
            "margin would shrink.",
            "PR-AUC is quoted against an OBSERVATION-level base rate of ~0.457. The "
            "listing-level waste rate is 24.8%; against that number the same PR-AUC would "
            "look nearly twice as good. The observation-level population is the one scored "
            "at serving time, so it is the correct denominator here.",
            "food_category is excluded. On simulated titles the keyword rules recover the "
            "generator's own category almost exactly, so the feature is more informative "
            "here than it could be in production. It was worth +0.0013 val PR-AUC.",
            "recipients_within_5km and recipients_within_15km carry a large share of the "
            "model's gain, and they are a LOSSY PROXY: the event log has no "
            "organization-registration event, so a recipient is invisible until its first "
            "claim. Their distributions are stable across splits (per-split medians 40/42/41 "
            "and 238/246/243, identical maxima), so this is not producing train-to-test "
            "drift — but the feature would improve immediately if FFE emitted an "
            "org_registered event. See docs/ML Subsystem.md §7.",
            "Hyperparameters and the calibrator are both fitted on val_fit. Calibration "
            "measured on that slice would be optimistic; the Brier score and reliability "
            "curve reported for `test` are the honest ones.",
        ],
    }
