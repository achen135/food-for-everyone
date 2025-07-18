"""Volume and time-span: the floor `docs/ML Subsystem.md` §5 sets.

    ">=100k listing events / >=6 simulated months"

Read as: at least 100,000 `listing_posted` events across at least six months of
simulated time. `listing_posted` is the right thing to count because it is what
bounds the training set — one listing is one labelled subject, however many
claim and completion rows it goes on to generate.

These assertions exist so the floor is enforced rather than remembered. Tuning
the behavioural rates changes the corpus size, and it would be easy to drop
below 100k while chasing a nicer waste rate and not notice until a résumé
bullet had already been written around the old number.
"""

from __future__ import annotations

import collections

from ml.simulate.config import SimulationConfig
from tests.conftest import requires_slow, run_cli

REQUIRED_POSTED = 100_000
REQUIRED_MONTHS = 6


def test_committed_defaults_target_at_least_six_months() -> None:
    config = SimulationConfig()
    assert config.months >= REQUIRED_MONTHS
    assert config.days >= 180
    assert (config.end - config.start).days == config.days


def test_start_is_fixed_rather_than_relative_to_now() -> None:
    """A corpus whose timestamps move cannot be byte-identical across runs, and
    M12's committed `baselines.json` would stop reproducing a month later.

    This is the one place the ml corpus deliberately differs from
    `supabase/seed/activity.ts`, which slides its window on purpose so a
    freshly seeded dashboard always shows recent activity.
    """
    assert SimulationConfig().start == SimulationConfig().start
    assert SimulationConfig().start.year == 2025


def test_projected_volume_clears_the_floor() -> None:
    """The fast guard: one simulated month, extrapolated.

    A full run takes about half a minute, which is too slow to sit in the
    default suite but not too slow for CI — `test_full_scale_corpus` below does
    the real thing. This one catches a rate change that halves the corpus
    within a couple of seconds.
    """
    result = run_cli("--months", "1", "--out", "jsonl", "--path", "-", "--stats-json")
    posted = result.stats["listings_posted"]
    projected = posted * REQUIRED_MONTHS
    assert projected >= REQUIRED_POSTED, (
        f"one month produced {posted:,} listing_posted events, projecting to "
        f"{projected:,} over {REQUIRED_MONTHS} months — under the {REQUIRED_POSTED:,} floor"
    )


@requires_slow()
def test_full_scale_corpus() -> None:
    """The DoD, run for real: >=100k posted events over >=6 simulated months,
    with all five event types present and a usable positive class."""
    result = run_cli("--out", "jsonl", "--path", "-", "--stats-json")
    stats = result.stats

    assert stats["months"] >= REQUIRED_MONTHS
    assert stats["listings_posted"] >= REQUIRED_POSTED

    counts = collections.Counter(e["event_type"] for e in result.events)
    assert len(counts) == 5
    assert sum(counts.values()) == stats["events"]

    # The positive class has to be worth modelling. Too rare and PR-AUC is
    # noise; near half and the problem is trivial and the "imbalanced" framing
    # in §6 would be false. This is a wide band — it is a guard against the
    # rates drifting somewhere useless, not a target.
    decided = stats["listings_posted"] - stats["censored"]
    waste_rate = stats["wasted"] / decided
    assert 0.10 <= waste_rate <= 0.45, f"waste rate {waste_rate:.1%} is outside the usable band"

    # Right-censoring must be a rounding error, not a population. Pickup windows
    # are hours long, so almost every listing posted inside the window also
    # resolves inside it; a spike here would mean M12 was dropping real data.
    assert stats["censored"] / stats["listings_posted"] < 0.01


@requires_slow()
def test_time_span_covers_the_whole_window() -> None:
    """Events must actually spread across the six months rather than bunching.

    A scheduling bug that generated everything in the first week would still
    satisfy a row count.
    """
    result = run_cli("--out", "jsonl", "--path", "-", "--stats-json")
    days = collections.Counter(e["occurred_at"][:10] for e in result.events)
    config = SimulationConfig()

    assert len(days) >= config.days - 1
    busiest = max(days.values())
    typical = sorted(days.values())[len(days) // 2]
    assert busiest < typical * 3, "activity is concentrated in a few days"
