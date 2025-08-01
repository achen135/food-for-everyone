"""The leakage guard — the headline correctness check of M12.

Point-in-time correctness is the easiest thing in a feature pipeline to get
wrong and the hardest to notice. A leaked feature does not crash. It produces a
model that scores beautifully offline and collapses in production, and by then
the offline number is in a slide deck.

Three assertions, in increasing strength:

1. **The pipeline agrees with the reference.** `pipeline.py` is a single
   forward pass with incremental state; `reference.py` filters the whole log at
   the top of one function. They share no code below `spec.py`, so agreement on
   a random sample of rows is real evidence rather than two copies of the same
   bug.

2. **The reference does not read the future.** Handing it the *entire* log must
   produce identical values to handing it only events with
   `occurred_at <= as_of`. It can only do that if nothing inside ever looks
   forward. This is a statement about the code, not a spot check about the data,
   and it is the assertion the brief asks for as "assert no feature function
   reads an event after as_of".

3. **Truncating the log at `as_of` changes nothing.** The strongest form: build
   the whole pipeline again over a prefix of the log and confirm the rows it
   produces for that prefix are byte-identical to the ones the full run
   produced. A feature that peeked ahead would differ, because in the truncated
   run there is nothing ahead to peek at.

These run on a small corpus generated in-process. The guard tests correctness,
not scale, and the reference implementation is O(events) per row — at full
corpus size a sample of 200 rows would take minutes and the test would be
skipped by whoever was in a hurry.
"""

from __future__ import annotations

import random

import pytest

from ml.features.labels import build_label_index
from ml.features.log import LogEvent, from_events, sorted_log
from ml.features.pipeline import Observation, PipelineStats, build_observations
from ml.features.reference import features_as_of
from ml.features.spec import FEATURE_NAMES, FLOAT_TOLERANCE
from ml.simulate.config import SimulationConfig
from ml.simulate.engine import simulate

SAMPLE_SIZE = 60


def _values_equal(left: object, right: object) -> bool:
    """Compare one feature value from two independent computations."""
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        # Different code paths accumulate in a different order, so exact float
        # equality is the wrong assertion. The tolerance is far tighter than any
        # real leak: a leaked event moves a count by a whole unit.
        return abs(float(left) - float(right)) <= max(FLOAT_TOLERANCE, abs(float(right)) * 1e-9)
    return left == right


def _assert_rows_match(
    observed: dict[str, object], expected: dict[str, object], context: str
) -> None:
    mismatched = [
        name for name in FEATURE_NAMES if not _values_equal(observed[name], expected[name])
    ]
    assert not mismatched, "\n".join(
        [f"{context}: {len(mismatched)} feature(s) disagree"]
        + [f"  {name}: got {observed[name]!r}, expected {expected[name]!r}" for name in mismatched]
    )


@pytest.fixture(scope="module")
def corpus() -> tuple[list[LogEvent], list[Observation], PipelineStats]:
    """A small corpus, its sorted log, and every observation the pipeline emits."""
    config = SimulationConfig(seed=8123, months=1, n_donors=30, n_recipients=20)
    events, _stats = simulate(config)
    log = sorted_log(from_events(events))
    stats = PipelineStats()
    observations = list(build_observations(iter(log), stats))
    assert observations, "the corpus produced no observations"
    return log, observations, stats


def test_streaming_pipeline_matches_the_reference(
    corpus: tuple[list[LogEvent], list[Observation], PipelineStats],
) -> None:
    """Assertion 1. The fast path is checked against the obvious one.

    This is the test that found all three of M12's real bugs: a listing that was
    never decremented from the open count at `pickup_end` (there is no expiry
    event to hang it on), counters maintained over a neighbour list that grows
    as donors appear, and a claim rate that counted claim events rather than
    distinct listings.
    """
    log, observations, _stats = corpus
    sample = random.Random(17).sample(observations, min(SAMPLE_SIZE, len(observations)))

    for observation in sample:
        expected = features_as_of(log, observation.listing_id, observation.as_of)
        _assert_rows_match(
            observation.features,
            expected,
            f"listing {observation.listing_id[:8]} at {observation.as_of}",
        )


def test_reference_ignores_events_after_as_of(
    corpus: tuple[list[LogEvent], list[Observation], PipelineStats],
) -> None:
    """Assertion 2. No feature function reads an event after `as_of`.

    The whole log versus only its prefix, into the same function. Identical
    output is only possible if the filter at the top of `features_as_of` is the
    only thing that decides what is visible.
    """
    log, observations, _stats = corpus
    last_event = log[-1].occurred_at
    # Only observations with events still ahead of them can demonstrate
    # anything: for one taken after the final event there is no future to
    # ignore, so including it would make the test pass for the wrong reason.
    candidates = [o for o in observations if o.as_of < last_event]
    assert candidates, "every observation is after the last event"
    sample = random.Random(23).sample(candidates, min(SAMPLE_SIZE, len(candidates)))

    for observation in sample:
        as_of = observation.as_of
        truncated = [event for event in log if event.occurred_at <= as_of]
        assert len(truncated) < len(log)

        with_future = features_as_of(log, observation.listing_id, as_of)
        without_future = features_as_of(truncated, observation.listing_id, as_of)
        _assert_rows_match(with_future, without_future, f"reference saw the future at {as_of}")


def test_pipeline_output_is_unchanged_by_truncating_the_log(
    corpus: tuple[list[LogEvent], list[Observation], PipelineStats],
) -> None:
    """Assertion 3. Re-running the pipeline over a prefix reproduces the prefix.

    Everything the full run emitted before the cut must come out identical when
    the events after the cut do not exist. This catches a leak the other two
    could miss — one in the *streaming* code specifically, where state is
    mutated by a later event before an earlier observation is emitted.
    """
    log, observations, _stats = corpus
    cut = log[len(log) // 2].occurred_at

    # Both runs are compared only up to the cut. The truncated run keeps
    # emitting past it — its heap of pending observations drains after the last
    # event, for listings still open — and those rows genuinely differ from the
    # full run's, because in the full run more events had happened by then.
    # That is correct behaviour, not a leak: the claim being tested is about
    # observations at or before the cut.
    truncated_run = [
        observation
        for observation in build_observations(iter([e for e in log if e.occurred_at <= cut]))
        if observation.as_of <= cut
    ]
    expected = {(o.listing_id, o.as_of): o.features for o in observations if o.as_of <= cut}

    assert expected, "no observations before the cut"
    assert truncated_run, "the truncated run produced nothing"
    assert {(o.listing_id, o.as_of) for o in truncated_run} == set(expected), (
        "the two runs disagree about WHICH observations exist before the cut"
    )

    for observation in truncated_run:
        key = (observation.listing_id, observation.as_of)
        _assert_rows_match(
            observation.features, expected[key], f"truncated run differs at {observation.as_of}"
        )


def test_labels_are_computed_from_a_separate_pass(
    corpus: tuple[list[LogEvent], list[Observation], PipelineStats],
) -> None:
    """The label is allowed to see the future; the features are not.

    Structural, not incidental: `build_observations` has no reference to
    `LabelIndex`, so there is no path by which a feature could reach the
    object that knows the outcome.
    """
    log, observations, _stats = corpus
    index = build_label_index(iter(log))

    labelled = 0
    for observation in observations[:500]:
        label, reason = index.label(observation.listing_id, observation.as_of)
        assert reason in {"wasted", "claimed", "withdrawn", "censored"}
        if label is not None:
            assert label in (0, 1)
            labelled += 1
    assert labelled > 0

    # The structural half: the module that computes features imports nothing
    # that knows an outcome. Checked against the module namespace rather than
    # its source text — a comment mentioning the word "label" is not a leak,
    # and a test that cannot tell the difference gets deleted the first time
    # somebody writes a helpful comment.
    import ml.features.pipeline as pipeline_module

    forbidden = {"LabelIndex", "build_label_index", "ListingFacts", "LabelOutcome"}
    assert not (forbidden & set(vars(pipeline_module))), (
        "the feature pipeline imported something that knows the future"
    )
