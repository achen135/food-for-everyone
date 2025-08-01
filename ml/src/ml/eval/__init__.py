"""Evaluation: time splits, metrics, and the harness that reports them."""

from ml.eval.metrics import evaluate_scores
from ml.eval.splits import SplitPlan, assign_splits

__all__ = ["SplitPlan", "assign_splits", "evaluate_scores"]
