"""Split integrity — no listing in two splits, no `as_of` overlap between them.

A random split of `features_waste` would be catastrophic and would look
excellent: the same listing contributes one row per hour it stays open, so
random assignment puts observations of the same listing in both train and test
and the model gets to memorise outcomes it is being scored on. These tests are
what stops that reappearing through a refactor.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from ml.eval.splits import (
    TRAIN_FRACTION,
    VAL_FRACTION,
    SplitPlan,
    assign_splits,
    plan_splits,
)
from ml.features.labels import LabelIndex, build_label_index
from ml.features.log import from_events, sorted_log
from ml.features.pipeline import build_observations
from ml.simulate.config import SimulationConfig
from ml.simulate.engine import simulate


def _corpus(
    seed: int = 6161,
) -> tuple[list[tuple[str, datetime, int, str]], SplitPlan, int, LabelIndex]:
    config = SimulationConfig(seed=seed, months=2, n_donors=40, n_recipients=28)
    events, _ = simulate(config)
    log = sorted_log(from_events(events))
    index = build_label_index(iter(log))
    assignment, plan, purged = assign_splits(
        {lid: (f.posted_at, f.pickup_end) for lid, f in index.listings.items()},
        index.corpus_start,
        index.corpus_end,
    )
    rows: list[tuple[str, datetime, int, str]] = []
    for observation in build_observations(iter(log)):
        split = assignment.get(observation.listing_id)
        if split is None:
            continue
        label, _reason = index.label(observation.listing_id, observation.as_of)
        if label is None:
            continue
        rows.append((observation.listing_id, observation.as_of, label, split))
    return rows, plan, purged, index


def test_boundaries_are_ordered_and_at_the_stated_fractions() -> None:
    start = datetime.fromisoformat("2025-01-01T00:00:00+00:00")
    end = start + timedelta(days=100)
    plan = plan_splits(start, end)

    assert plan.start < plan.train_end < plan.val_end < plan.end
    assert (plan.train_end - start).days == int(100 * TRAIN_FRACTION)
    assert (plan.val_end - start).days == int(100 * (TRAIN_FRACTION + VAL_FRACTION))


def test_a_listing_straddling_a_boundary_is_purged() -> None:
    start = datetime.fromisoformat("2025-01-01T00:00:00+00:00")
    end = start + timedelta(days=100)
    plan = plan_splits(start, end)

    inside = plan.train_end - timedelta(hours=5)
    listings = {
        "kept": (inside, inside + timedelta(hours=1)),
        "straddles": (inside, plan.train_end + timedelta(hours=10)),
    }
    assignment, _plan, purged = assign_splits(listings, start, end)

    assert assignment == {"kept": "train"}
    assert purged == 1


def test_no_listing_appears_in_two_splits() -> None:
    rows, _plan, _purged, _index = _corpus()
    seen: dict[str, str] = {}
    for listing_id, _as_of, _label, split in rows:
        previous = seen.setdefault(listing_id, split)
        assert previous == split, f"listing {listing_id[:8]} is in both {previous} and {split}"


def test_split_as_of_windows_do_not_overlap() -> None:
    """Every train observation precedes every validation one, and so on.

    This is what purging buys. Without it, a listing posted just before a
    boundary emits rows on both sides of it and the "strict time split" is not
    strict.
    """
    rows, _plan, _purged, _index = _corpus()
    ranges: dict[str, tuple[datetime, datetime]] = {}
    for _listing_id, as_of, _label, split in rows:
        low, high = ranges.get(split, (as_of, as_of))
        ranges[split] = (min(low, as_of), max(high, as_of))

    assert set(ranges) == {"train", "val", "test"}
    assert ranges["train"][1] <= ranges["val"][0]
    assert ranges["val"][1] <= ranges["test"][0]


def test_purging_actually_removes_something() -> None:
    """If this ever hit zero, the guarantee above would be holding by accident
    rather than by construction, and the next change to the cadence would break
    it silently."""
    _rows, _plan, purged, index = _corpus()
    assert purged > 0
    assert purged < len(index.listings) * 0.2, "purging is discarding an implausible share"


def test_every_split_has_both_classes() -> None:
    """A split with one class makes AUC undefined; `evaluate_scores` raises on
    it, and this catches the condition before the harness does."""
    rows, _plan, _purged, _index = _corpus()
    for split in ("train", "val", "test"):
        labels = [label for _lid, _as_of, label, s in rows if s == split]
        assert labels, f"{split} is empty"
        assert 0 < sum(labels) < len(labels), f"{split} has a single class"
