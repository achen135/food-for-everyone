"""Point-in-time feature computation from the event log.

Two implementations of the same thing, on purpose:

- `reference.py` — slow, obvious, filters the log at the top of one function.
  This is the specification.
- `pipeline.py` — a single forward pass with incremental state. This is what
  runs.

`ml/tests/test_leakage.py` asserts they agree, and separately asserts that the
reference produces identical values whether it is handed the whole log or only
the part up to `as_of` — which it can only do if nothing inside looks forward.
"""

from ml.features.labels import LabelIndex, LabelOutcome, build_label_index
from ml.features.pipeline import Observation, PipelineStats, build_observations
from ml.features.reference import features_as_of
from ml.features.spec import FEATURE_NAMES

__all__ = [
    "FEATURE_NAMES",
    "LabelIndex",
    "LabelOutcome",
    "Observation",
    "PipelineStats",
    "build_label_index",
    "build_observations",
    "features_as_of",
]
