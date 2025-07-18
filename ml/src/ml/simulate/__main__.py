"""CLI: `python -m ml.simulate --seed <int> --months <int> [--out postgres|jsonl]`.

Stats always go to **stderr**, never stdout. That is what lets

    python -m ml.simulate --out jsonl --path - | shasum -a 256

be the determinism check: stdout carries the event stream and nothing else, so
the hash is of the data rather than of the data plus a summary line that
happens to mention a row count.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import UTC, datetime

from ml.simulate.config import DEFAULT_START, SimulationConfig
from ml.simulate.engine import SimulationStats, simulate
from ml.simulate.sink import JsonlSink, Sink, drain


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    # An instance, not the class: `SimulationConfig` uses `slots=True`, so
    # `SimulationConfig.seed` is a member descriptor rather than the default
    # value. Reading defaults off a constructed config keeps the CLI and the
    # dataclass from drifting apart.
    defaults = SimulationConfig()

    parser = argparse.ArgumentParser(
        prog="python -m ml.simulate",
        description=(
            "Generate a deterministic, labelled events corpus. "
            "Same seed and months always produce the same stream."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=defaults.seed,
        help="Master seed. Everything downstream derives from it.",
    )
    parser.add_argument(
        "--months",
        type=int,
        default=defaults.months,
        help="Simulated months to generate (docs/ML Subsystem.md §5 requires >= 6).",
    )
    parser.add_argument(
        "--out",
        choices=("postgres", "jsonl"),
        default="postgres",
        help="Where to write. `make data` uses postgres; jsonl is the reference stream.",
    )
    parser.add_argument(
        "--path",
        default="-",
        help="JSONL destination. `-` is stdout (the default), so the stream can be piped.",
    )
    parser.add_argument(
        "--dsn",
        default=None,
        help="Postgres DSN. Defaults to $ML_DATABASE_URL, then the compose database.",
    )
    parser.add_argument(
        "--start",
        default=None,
        help=(
            "ISO-8601 start instant. Defaults to a fixed date, NOT to now — a "
            "corpus whose timestamps move cannot be byte-identical across runs."
        ),
    )
    parser.add_argument("--donors", type=int, default=defaults.n_donors, help="Donor count.")
    parser.add_argument(
        "--recipients",
        type=int,
        default=defaults.n_recipients,
        help="Recipient count.",
    )
    parser.add_argument(
        "--no-truncate",
        action="store_true",
        help="Append to public.events instead of replacing it. Postgres output only.",
    )
    parser.add_argument(
        "--stats-json",
        action="store_true",
        help="Emit the run summary as JSON on stderr rather than as a table.",
    )
    return parser.parse_args(argv)


def _report(stats: SimulationStats, config: SimulationConfig, as_json: bool) -> None:
    resolved = {
        "seed": config.seed,
        "months": config.months,
        "days": config.days,
        "start": config.start.isoformat(),
        "end": config.end.isoformat(),
        **asdict(stats),
        "events": stats.events,
    }
    if as_json:
        print(json.dumps(resolved, sort_keys=True), file=sys.stderr)
        return

    decided = stats.listings_posted - stats.censored
    waste_rate = (stats.wasted / decided * 100.0) if decided else 0.0
    lines = [
        f"seed {config.seed}  months {config.months}  days {config.days}",
        f"window {config.start.date()} .. {config.end.date()}",
        f"orgs                {stats.donors} donors / {stats.recipients} recipients",
        f"listing_posted      {stats.listings_posted:,}",
        f"listing_claimed     {stats.listings_claimed:,}",
        f"claim_completed     {stats.claims_completed:,}",
        f"claim_cancelled     {stats.claims_cancelled:,}",
        f"listing_cancelled   {stats.listings_cancelled:,}",
        f"total events        {stats.events:,}",
        f"wasted (label = 1)  {stats.wasted:,}  ({waste_rate:.1f}% of decided listings)",
        f"right-censored      {stats.censored:,}  (still open at the window's end)",
    ]
    print("\n".join(lines), file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.months < 1:
        print("--months must be at least 1", file=sys.stderr)
        return 2

    start = DEFAULT_START
    if args.start is not None:
        parsed = datetime.fromisoformat(args.start)
        start = parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    config = SimulationConfig(
        seed=args.seed,
        months=args.months,
        start=start,
        n_donors=args.donors,
        n_recipients=args.recipients,
    )

    events, stats = simulate(config)

    if args.out == "jsonl":
        sink: Sink = JsonlSink(args.path)
        try:
            drain(events, sink)
        finally:
            sink.close()
    else:
        from ml.db import bootstrap, connect, truncate_events
        from ml.simulate.sink import PostgresSink

        with connect(args.dsn) as conn:
            bootstrap(conn)
            if not args.no_truncate:
                truncate_events(conn)
            drain(events, PostgresSink(conn))

    _report(stats, config, args.stats_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
