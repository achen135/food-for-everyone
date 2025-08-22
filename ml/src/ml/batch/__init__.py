"""Batch scoring: re-score every open listing, write the current risk tier.

`__main__` drives it; `writeback` holds the two destinations. See
`docs/ML Subsystem.md` §5 (M14) for what this milestone is.
"""

from ml.batch.writeback import (
    CorpusRiskWriter,
    ListingRiskWriter,
    RiskRow,
    RiskWriter,
    writer_for,
)

__all__ = [
    "CorpusRiskWriter",
    "ListingRiskWriter",
    "RiskRow",
    "RiskWriter",
    "writer_for",
]
