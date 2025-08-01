"""CLI: `python -m ml.features` — build `features_waste` from the event log.

Two passes over the log, and the separation between them is the point.

**Pass 1** builds `LabelIndex`: for each listing, when it was posted, when its
window closes, when it was claimed, when it was withdrawn while unclaimed. This
pass is allowed to see everything, because the label is *supposed* to know the
future.

**Pass 2** streams the log forward through `build_observations`, which holds
only accumulated state and therefore cannot see past `as_of`. Each observation
is then labelled by looking the answer up in the pass-1 index.

Keeping them apart is what makes leakage a structural impossibility rather than
a discipline: the code that computes features has no reference to the object
that knows the future.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Iterator

from ml.db import bootstrap, connect
from ml.eval.splits import assign_splits
from ml.features.labels import LabelIndex, build_label_index
from ml.features.log import LogEvent, from_jsonl, from_postgres
from ml.features.pipeline import PipelineStats, build_observations
from ml.features.spec import OBSERVATION_INTERVAL_HOURS
from ml.features.writer import truncate_features, write_features


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ml.features",
        description="Compute point-in-time features and labels into features_waste.",
    )
    parser.add_argument(
        "--source",
        choices=("postgres", "jsonl"),
        default="postgres",
        help="Where the event log comes from. `make features` uses postgres.",
    )
    parser.add_argument("--path", default=None, help="JSONL event log, when --source jsonl.")
    parser.add_argument("--dsn", default=None, help="Corpus DSN. Defaults to $ML_DATABASE_URL.")
    parser.add_argument(
        "--no-truncate",
        action="store_true",
        help="Append to features_waste instead of replacing it.",
    )
    parser.add_argument("--stats-json", action="store_true", help="Summary as JSON on stderr.")
    return parser.parse_args(argv)


def _report(
    index: LabelIndex,
    stats: PipelineStats,
    reasons: Counter[str],
    written: int,
    purged: int,
    plan_description: dict[str, str],
    as_json: bool,
) -> None:
    summary = {
        "events_read": stats.events_read,
        "listings": stats.listings_seen,
        "donors": stats.donors,
        "recipients": stats.recipients,
        "observations": stats.observations,
        "written": written,
        "listings_purged_at_split_boundary": purged,
        "dropped_withdrawn": reasons["withdrawn"],
        "dropped_censored": reasons["censored"],
        "dropped_purged": reasons["purged"],
        "positives": reasons["wasted"],
        "negatives": reasons["claimed"],
        "observation_interval_hours": OBSERVATION_INTERVAL_HOURS,
        **plan_description,
    }
    if as_json:
        print(json.dumps(summary, sort_keys=True), file=sys.stderr)
        return

    labelled = reasons["wasted"] + reasons["claimed"]
    rate = reasons["wasted"] / labelled if labelled else 0.0
    per_listing = written / stats.listings_seen if stats.listings_seen else 0.0
    lines = [
        f"events read         {stats.events_read:,}",
        f"listings            {stats.listings_seen:,}"
        f"  ({stats.donors} donors, {stats.recipients} recipients)",
        f"observations        {stats.observations:,}  ({per_listing:.1f} per listing)",
        "",
        f"written             {written:,}",
        f"  label = 1         {reasons['wasted']:,}  ({rate:.1%} of labelled rows)",
        f"  label = 0         {reasons['claimed']:,}",
        "dropped",
        f"  withdrawn         {reasons['withdrawn']:,}  (a donor pulled it; not wasted food)",
        f"  right-censored    {reasons['censored']:,}  (outcome outside the corpus)",
        f"  split-purged      {reasons['purged']:,}  ({purged:,} listings straddling a boundary)",
        "",
        f"train ends          {plan_description['train_end']}",
        f"val ends            {plan_description['val_end']}",
    ]
    print("\n".join(lines), file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.source == "jsonl" and not args.path:
        print("--source jsonl needs --path", file=sys.stderr)
        return 2

    # Two connections, deliberately.
    #
    # Pass 2 streams the event log out of a server-side cursor while COPYing
    # feature rows in. A psycopg connection carries one protocol conversation at
    # a time, so doing both on one connection does not error — it **hangs**, the
    # COPY waiting to send while the cursor waits to fetch. Splitting them is
    # the fix; sharing one and materialising the log first would work too, and
    # would cost most of a gigabyte to avoid a second socket.
    with connect(args.dsn) as write_conn, connect(args.dsn) as read_conn:
        bootstrap(write_conn)

        def read_log() -> Iterator[LogEvent]:
            if args.source == "jsonl":
                return from_jsonl(args.path)
            return from_postgres(read_conn)

        # Pass 1 — the future is allowed here.
        index = build_label_index(read_log())

        assignment, plan, purged = assign_splits(
            {
                listing_id: (facts.posted_at, facts.pickup_end)
                for listing_id, facts in index.listings.items()
            },
            index.corpus_start,
            index.corpus_end,
        )

        # Pass 2 — the future is not.
        stats = PipelineStats()
        reasons: Counter[str] = Counter()

        def labelled_rows() -> Iterator[tuple[str, object, dict[str, object], int, str]]:
            for observation in build_observations(read_log(), stats):
                # Label first, then split. Both can drop a row and some rows
                # qualify for both — a listing at the very end of the corpus is
                # right-censored *and* straddles the end of the test window —
                # so the order decides which reason gets reported. Censoring is
                # the more informative attribution: it says the outcome is
                # unknown, where "purged" only says the row sat near a boundary.
                label, reason = index.label(observation.listing_id, observation.as_of)
                if label is None:
                    reasons[reason] += 1
                    continue
                split = assignment.get(observation.listing_id)
                if split is None:
                    reasons["purged"] += 1
                    continue
                reasons[reason] += 1
                yield (
                    observation.listing_id,
                    observation.as_of,
                    observation.features,
                    label,
                    split,
                )

        if not args.no_truncate:
            truncate_features(write_conn)
        written = write_features(write_conn, labelled_rows())  # type: ignore[arg-type]

    _report(index, stats, reasons, written, purged, plan.describe(), args.stats_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
