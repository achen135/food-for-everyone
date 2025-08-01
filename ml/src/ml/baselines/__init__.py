"""Rules baselines — the bar M13's model has to clear.

Two rules, both from `docs/ML Subsystem.md` §5, implemented and measured before
any model exists. That ordering is the point: a PR-AUC quoted with nothing to
compare it against says nothing, and the most common way an ML result turns out
to be worthless is that a two-line rule would have done as well.
"""

from ml.baselines.rules import BASELINES, Baseline, score_baseline

__all__ = ["BASELINES", "Baseline", "score_baseline"]
