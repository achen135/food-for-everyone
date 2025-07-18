"""Determinism: same seed, byte-identical stream.

This is the property the whole corpus rests on. `ml/baselines.json` (M12) and
every metric after it are only reproducible if regenerating the data produces
exactly the data they were computed from.
"""

from __future__ import annotations

from ml.simulate.config import SimulationConfig
from ml.simulate.orgs import build_population
from tests.conftest import run_cli

SMALL = ("--months", "1", "--donors", "60", "--recipients", "40", "--out", "jsonl", "--path", "-")


def test_same_seed_same_bytes_across_processes() -> None:
    """Two fresh interpreters, two different hash salts, one hash.

    The salt is the point. Set iteration and `hash()` on strings are salted per
    process, so a generator that iterated a set somewhere would produce a
    different order here and only here — not in a same-process second run,
    which is why this test pays for two subprocesses.
    """
    first = run_cli(*SMALL, "--seed", "4242", hashseed="0")
    second = run_cli(*SMALL, "--seed", "4242", hashseed="12345")

    assert first.sha256 == second.sha256
    assert first.stdout == second.stdout


def test_different_seed_different_bytes() -> None:
    """The guard on the guard: a test that passed for an empty stream, or for a
    generator that ignored its seed, would be worthless."""
    first = run_cli(*SMALL, "--seed", "4242")
    second = run_cli(*SMALL, "--seed", "4243")

    assert first.sha256 != second.sha256
    assert len(first.stdout) > 0


def test_file_and_stdout_agree(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """`--path -` and `--path FILE` must produce the same bytes.

    They go through different branches of `JsonlSink` — one writes to an
    already-open stdout, the other opens a file with an explicit newline mode.
    A platform-dependent line ending would show up here.
    """
    target = tmp_path / "events.jsonl"
    piped = run_cli(*SMALL, "--seed", "77")
    run_cli(
        "--months",
        "1",
        "--donors",
        "60",
        "--recipients",
        "40",
        "--out",
        "jsonl",
        "--path",
        str(target),
        "--seed",
        "77",
    )
    assert target.read_bytes() == piped.stdout


def test_population_is_a_pure_function_of_the_seed() -> None:
    """Org traits come out identical without going near the event loop."""
    config = SimulationConfig(seed=99, months=1, n_donors=40, n_recipients=25)
    first = build_population(config)
    second = build_population(config)

    assert first == second
    assert [d.id for d in first.donors] == [d.id for d in second.donors]


def test_recipient_count_does_not_disturb_donor_traits() -> None:
    """Substreams, doing their job.

    Donors and recipients are drawn from separately derived generators, so
    changing the recipient count must leave every donor untouched. Without this
    property, tuning the population would reshuffle the whole corpus and the
    determinism test above would fail on every scale change — at which point
    somebody deletes the determinism test.
    """
    base = SimulationConfig(seed=5, months=1, n_donors=30, n_recipients=20)
    wider = SimulationConfig(seed=5, months=1, n_donors=30, n_recipients=200)

    assert build_population(base).donors == build_population(wider).donors
