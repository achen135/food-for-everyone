"""`python -m ml.batch` — re-score every open listing into `listing_risk`.

## What a run is

Warm one `FeatureState` to `as_of`, ask it which listings are open, score each
through the committed model, upsert the tiers, delete the rows for listings
that have since closed. That is the whole job, and every piece of it is code
M13 already shipped: `ScoringService` does "replay → open_listings → score" and
this module adds the write-back and the pruning around it. Reimplementing the
scoring here would have created a second answer to "what are this listing's
features", which is the one thing the subsystem spends most of its effort
having exactly one of.

## `as_of` is explicit, and the default depends on the source

The M13 trap, restated because it costs an hour every time it is rediscovered:
the corpus ends **2025-07-07**, so a wall-clock `as_of` against it puts every
listing past its pickup window and the whole log scores as doomed — silently,
because "0 listings open" is a legitimate answer. So:

- `--source production` defaults `as_of` to **now**, which is correct: the
  live log is being scored as it stands.
- `--source corpus` defaults to `ML_SERVE_AS_OF` if set, else the log's own
  last instant, and **warns** if it is handed anything past the end of the log.

## Where the rows go is not a separate flag

`writer_for` derives the destination from the source. A corpus replay writing
into production would put simulated ids in the table the live app reads; the
combination has no legitimate use, so it is not expressible. See
`ml/src/ml/batch/writeback.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ml.batch.writeback import RiskRow, RiskWriter, writer_for
from ml.serve.scoring import ScoringService
from ml.serve.sources import EventSource, production_source

__all__ = ["BatchReport", "main", "run_batch"]


@dataclass(slots=True)
class BatchReport:
    """Everything a run wants to say about itself."""

    source: str
    target: str
    as_of: datetime
    model_version: str
    events_replayed: int = 0
    open_listings: int = 0
    scored: int = 0
    written: int = 0
    pruned: int = 0
    skipped: int = 0
    tiers: dict[str, int] = field(default_factory=dict)
    dry_run: bool = False

    def as_json(self) -> dict[str, object]:
        return {
            "source": self.source,
            "target": self.target,
            "as_of": self.as_of.isoformat(),
            "model_version": self.model_version,
            "events_replayed": self.events_replayed,
            "open_listings": self.open_listings,
            "scored": self.scored,
            "written": self.written,
            "pruned": self.pruned,
            "skipped": self.skipped,
            "tiers": self.tiers,
            "dry_run": self.dry_run,
        }

    def render(self) -> str:
        lines = [
            "ml batch — waste risk",
            f"  source          {self.source}",
            f"  target          {self.target}",
            f"  as_of           {self.as_of.isoformat()}",
            f"  model           {self.model_version}",
            f"  events replayed {self.events_replayed:,}",
            f"  open listings   {self.open_listings:,}",
            f"  scored          {self.scored:,}",
        ]
        if self.skipped:
            lines.append(f"  skipped         {self.skipped:,} (not scoreable at as_of)")
        for tier in ("high", "medium", "low"):
            if tier in self.tiers:
                lines.append(f"    {tier:<12}{self.tiers[tier]:,}")
        if self.dry_run:
            lines.append("  DRY RUN — nothing written")
        else:
            lines.append(f"  written         {self.written:,}")
            lines.append(f"  pruned          {self.pruned:,}")
        return "\n".join(lines)


def resolve_as_of(source_name: str, raw: str | None, source: EventSource) -> datetime:
    """Pick the instant to score at, per the rules in the module docstring."""
    if raw is not None and raw != "now":
        parsed = datetime.fromisoformat(raw)
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    if raw == "now" or source_name == "production":
        return datetime.now(UTC)

    configured = os.environ.get("ML_SERVE_AS_OF")
    if configured:
        parsed = datetime.fromisoformat(configured)
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)

    latest = source.latest_event_at()
    if latest is None:
        raise SystemExit("the event log is empty; run `make data` before scoring the corpus")
    return latest


def run_batch(
    source_name: str = "corpus",
    as_of_raw: str | None = None,
    *,
    dry_run: bool = False,
    prune: bool = True,
    log_predictions: bool | None = None,
    dsn: str | None = None,
    source: EventSource | None = None,
    writer: RiskWriter | None = None,
) -> BatchReport:
    """One batch pass. Returns the report; raises only on real failures."""
    resolved_source = source if source is not None else production_source(source_name)
    resolved_writer = writer if writer is not None else writer_for(source_name, dsn)
    as_of = resolve_as_of(source_name, as_of_raw, resolved_source)

    if source_name == "corpus":
        latest = resolved_source.latest_event_at()
        if latest is not None and as_of > latest:
            print(
                f"warning: as_of {as_of.isoformat()} is past the corpus's last event "
                f"({latest.isoformat()}). Every listing will read as closed and nothing "
                "will be scored — this is the wall-clock-against-the-corpus trap.",
                file=sys.stderr,
            )

    # Predictions are corpus-side history. A production run in CI has no corpus
    # database to write them to, so the default follows the source rather than
    # failing on a connection that was never going to exist.
    write_predictions = log_predictions if log_predictions is not None else source_name == "corpus"

    service = ScoringService(
        source=resolved_source,
        cursor=as_of,
        log_predictions=write_predictions and not dry_run,
        dsn=dsn,
    )
    service.warm()

    report = BatchReport(
        source=source_name,
        target=resolved_writer.label,
        as_of=as_of,
        model_version=service.model.model_version,
        events_replayed=service.events_replayed,
    )

    try:
        open_ids = service.open_listings(as_of)
        report.open_listings = len(open_ids)

        rows: list[RiskRow] = []
        for listing_id in open_ids:
            try:
                result = service.score(listing_id, as_of)
            except (LookupError, ValueError):
                # `open_listings` and `score` ask the same state the same
                # question, so this should not fire. It is caught rather than
                # asserted because one unscoreable listing must not cost the
                # other several hundred their refresh.
                report.skipped += 1
                continue
            rows.append(
                RiskRow(
                    listing_id=result.listing_id,
                    risk_tier=result.risk_tier,
                    score=result.score,
                    model_version=result.model_version,
                    scored_at=as_of,
                )
            )
            report.tiers[result.risk_tier] = report.tiers.get(result.risk_tier, 0) + 1

        report.scored = len(rows)
        report.dry_run = dry_run

        if not dry_run:
            report.written = resolved_writer.upsert(rows)
            if prune:
                report.pruned = resolved_writer.prune(row.listing_id for row in rows)
    finally:
        service.close()

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ml.batch",
        description="Re-score every open listing and write current risk tiers.",
    )
    parser.add_argument(
        "--source",
        choices=("corpus", "production"),
        default="corpus",
        help="which event log to replay (default: corpus). The write target follows.",
    )
    parser.add_argument(
        "--as-of",
        default=None,
        help=(
            "ISO-8601 instant to score at, or 'now'. Defaults to now for production and "
            "to ML_SERVE_AS_OF / the log's last event for the corpus."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="score and report, write nothing",
    )
    parser.add_argument(
        "--no-prune",
        action="store_true",
        help="keep rows for listings that are no longer open",
    )
    parser.add_argument(
        "--predictions",
        dest="predictions",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="log every score to the corpus `predictions` table (default: corpus runs only)",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = run_batch(
        source_name=args.source,
        as_of_raw=args.as_of,
        dry_run=args.dry_run,
        prune=not args.no_prune,
        log_predictions=args.predictions,
    )
    print(json.dumps(report.as_json(), indent=2) if args.json else report.render())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
