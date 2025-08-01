"""Strict time splits, with purging.

## Why the obvious split is wrong

A random split of `features_waste` rows would be catastrophic and would look
excellent. The same listing contributes many rows — one per hour it stays open
— so a random assignment puts observations of *the same listing* in both train
and test. The model then gets to memorise outcomes it is being tested on, and
every metric comes out inflated. It is the single most common way a tabular ML
result turns out to be meaningless.

A per-listing random split fixes that and is still wrong, because the features
are computed from a shared, growing event log: a training listing from March
carries donor history and market conditions that a test listing from January
could not have known. Training on the future to predict the past overstates
what the model would do in production, where the future is not available.

## What this does instead

Cut the corpus into three contiguous windows by time — 60% train, 20%
validation, 20% test — and assign each **listing** by when it was posted. Then
**purge**: drop any listing whose pickup window extends past the end of its own
split. Observations stop before `pickup_end`, so a listing that clears this
check has every one of its observations inside its own window.

Two properties follow, and both are asserted in `ml/tests/test_splits.py`:

- **No listing spans two splits.** Assignment is per listing, so this is true by
  construction; the test guards against a refactor breaking it.
- **No `as_of` overlap between splits.** Train observations all precede the
  first boundary; validation observations all follow it. That is what purging
  buys, and without it a listing posted just before a boundary would emit rows
  on both sides of it.

Purging costs a few percent of listings, all of them near the two boundaries.
That is the right trade: the alternative is an evaluation whose splits leak into
each other by exactly the amount that flatters the model most.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

__all__ = ["TRAIN_FRACTION", "VAL_FRACTION", "Split", "SplitPlan", "assign_splits"]

Split = Literal["train", "val", "test"]

TRAIN_FRACTION: Final[float] = 0.60
VAL_FRACTION: Final[float] = 0.20


@dataclass(frozen=True, slots=True)
class SplitPlan:
    """The two boundaries, and the corpus bounds they were derived from."""

    start: datetime
    train_end: datetime
    val_end: datetime
    end: datetime

    def window_end(self, split: Split) -> datetime:
        return {"train": self.train_end, "val": self.val_end, "test": self.end}[split]

    def split_for(self, posted_at: datetime) -> Split:
        if posted_at < self.train_end:
            return "train"
        if posted_at < self.val_end:
            return "val"
        return "test"

    def describe(self) -> dict[str, str]:
        return {
            "start": self.start.isoformat(),
            "train_end": self.train_end.isoformat(),
            "val_end": self.val_end.isoformat(),
            "end": self.end.isoformat(),
        }


def plan_splits(start: datetime, end: datetime) -> SplitPlan:
    span = end - start
    return SplitPlan(
        start=start,
        train_end=start + span * TRAIN_FRACTION,
        val_end=start + span * (TRAIN_FRACTION + VAL_FRACTION),
        end=end,
    )


def assign_splits(
    listings: dict[str, tuple[datetime, datetime]],
    start: datetime,
    end: datetime,
) -> tuple[dict[str, Split], SplitPlan, int]:
    """Assign every listing to a split, purging the ones that straddle.

    `listings` maps listing id to `(posted_at, pickup_end)`. Returns the
    assignment (purged listings absent), the plan, and how many were purged.
    """
    plan = plan_splits(start, end)
    assignment: dict[str, Split] = {}
    purged = 0

    for listing_id, (posted_at, pickup_end) in listings.items():
        split = plan.split_for(posted_at)
        if pickup_end > plan.window_end(split):
            purged += 1
            continue
        assignment[listing_id] = split

    return assignment, plan, purged
