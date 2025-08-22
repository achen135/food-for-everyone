"""Where the events being scored come from.

## The decision this file records

M13's brief left the serving data source open, with three candidates: the
simulated corpus, a trimmed corpus slice hosted on Supabase, or FFE's
**production** `events` log. Settled with Alex before any of this was written:
**a pluggable `EventSource`, corpus-backed for M13's tests and benchmark, with
the production read path stubbed for M14.**

The reasoning, because it is the kind of choice that looks arbitrary later:

- The model is *trained* on simulated data, which is a documented limitation.
  Scoring a real open listing needs real events, so the production path has to
  exist eventually — but M14 is where "re-score every open listing" lives, and
  that is what makes it worth building.
- Production's `events` are mostly M10's one-time backfill. There is not enough
  history there to produce a p99 anyone should quote, and §6 of
  `docs/ML Subsystem.md` says the résumé number may only come from the committed
  k6 script.
- `ml/src/ml/db.py` refuses a Supabase DSN **on purpose**. A production read
  path is therefore a separate, read-only connection — never a loosened guard,
  and never the connection that writes `predictions`.

## What M14 actually built, and why it is simpler than M13 expected

M13 left `ProductionEventSource` as a stub whose docstring specified a
**scoped** query — the set of slices a per-listing read would have to cover to
reproduce `FeatureState`'s answers without replaying from the beginning. M14
implemented something deliberately simpler: a **full replay** of the production
log, and the reasoning is worth stating because it looks like the lazy option
and is not.

The scope analysis was written for the *serving* path, where a full replay per
request costs seconds and the p99 target rules it out. The batch job is the
opposite shape — it replays **once** per run, every few hours, and then scores
every open listing off the one warm state. At production's current size
(~700 events) a full replay is milliseconds, and it is *exactly* the
computation `build_observations` performs, so there is no scope to get wrong
and therefore **no skew to detect**. The scoped query would have been more
code, strictly more risk, and slower to trust.

That trade flips somewhere, and the crossover is a size not a date: when a full
replay stops fitting comfortably in the batch job's startup budget — order 10⁶
events, extrapolating from the corpus's 309k replaying in a few seconds — the
scoped design becomes worth its risk. The slice list is preserved verbatim on
`ProductionEventSource.SCOPED_QUERY_DESIGN` rather than deleted, because
re-deriving it is most of that work and it was already done carefully once.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Protocol

from ml.db import connect
from ml.events import parse_instant
from ml.features.log import LogEvent, from_postgres
from ml.supabase_rest import SupabaseConfig, SupabaseRest

__all__ = [
    "CorpusEventSource",
    "EventSource",
    "ProductionEventSource",
    "production_source",
]


class EventSource(Protocol):
    """A log the scoring service can replay."""

    def replay(self, until: datetime | None) -> Iterator[LogEvent]:
        """Every event with `occurred_at <= until`, in chronological order."""
        ...

    def latest_event_at(self) -> datetime | None:
        """The most recent instant in the log, or `None` when it is empty."""
        ...


class CorpusEventSource:
    """The simulated corpus (`docker-compose.yml`, port 55432).

    Reads through `ml.db.connect`, so the "am I pointed at the wrong database?"
    question keeps its single answer and the Supabase guard still applies.
    """

    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    def replay(self, until: datetime | None) -> Iterator[LogEvent]:
        # Materialised inside the connection rather than yielded lazily out of
        # it: the caller folds every event into a `FeatureState` at startup and
        # holding a server-side cursor open across that work would pin a
        # connection for no benefit.
        with connect(self._dsn) as conn:
            for event in from_postgres(conn):
                if until is not None and event.occurred_at > until:
                    break
                yield event

    def latest_event_at(self) -> datetime | None:
        with connect(self._dsn) as conn:
            row = conn.execute("select max(occurred_at) from public.events").fetchone()
        return None if row is None else row[0]


class ProductionEventSource:
    """FFE's live `events` log, over PostgREST, read-only.

    Replays the whole log rather than a scoped slice — see the module docstring
    for why that is the right shape for a batch job and the wrong one for a
    per-request serving path, and where the crossover is.

    Read-only structurally: the underlying `SupabaseRest` is constructed with
    `read_only=True`, so every verb but GET raises before a request is built.
    The batch job's write path is a separate object naming a separate table
    (`ml.batch.writeback.ListingRiskWriter`).

    ## Production payloads are backfilled, and that is visible

    Every event M10's backfill synthesised carries `payload->>'backfilled' =
    'true'`. `FeatureState` never looks at that key, so it costs nothing on the
    scoring path — but it does mean `ml.events.validate_event` would reject
    these rows on the exact-key-set check. That is correct and not worth
    "fixing": the contract describes what the *simulator* emits, and a
    reconstructed row is honestly a different thing. Anything quoting a number
    derived from this source says "backfilled history", not "observed traffic".
    """

    #: The per-listing slice list from M13's stub, kept for the day a full
    #: replay stops fitting. Prose on purpose: it is a design note, not code.
    SCOPED_QUERY_DESIGN = """
    To reproduce FeatureState's answers for ONE listing without a full replay,
    a scoped read must cover:

    - the target listing's own `listing_posted`, for every intrinsic feature;
    - every event of every prior listing by the same donor, for the
      `donor_prior_*` track record and `donor_median_claim_latency`;
    - every `listing_posted` by any donor within MARKET_RADIUS_KM whose pickup
      window has not closed, for `open_listings_within_15km`;
    - every `listing_claimed` in the trailing CLAIM_WINDOW_HOURS near the
      donor, for `claims_within_15km_prior_7d`;
    - every `listing_claimed` whose recipient is within the radius, for the
      WHOLE LIFE OF THE LOG — `recipients_within_*` is cumulative, and a
      recipient enters the index through the claim it made, whoever's listing
      that was.

    That last slice is unbounded in time, so it wants a maintained per-donor
    recipient count rather than a query — a schema decision, and the strongest
    argument for the `org_registered` event (docs/ML Subsystem.md §7).
    """

    def __init__(self, config: SupabaseConfig | None = None) -> None:
        self._rest = SupabaseRest(config, read_only=True)

    @property
    def project_url(self) -> str:
        return self._rest.project_url

    def replay(self, until: datetime | None) -> Iterator[LogEvent]:
        """Every production event with `occurred_at <= until`, chronologically.

        Ordered by `(occurred_at, id)` — the same total order
        `ml.features.log.from_postgres` uses against the corpus, and the same
        one the identity primary key was chosen to provide. Two events sharing
        a microsecond must fold in the same order here as they do in the batch
        pipeline or the two would disagree about a tie-break.

        Filtering is done server-side (`occurred_at=lte.…`) rather than by
        breaking out of the loop: over HTTP, pages already fetched are already
        paid for.
        """
        filters: dict[str, str] = {}
        if until is not None:
            filters["occurred_at"] = f"lte.{until.isoformat()}"

        rows = self._rest.select(
            "events",
            columns="occurred_at,event_type,listing_id,claim_id,actor_org_id,payload",
            order="occurred_at.asc,id.asc",
            filters=filters,
        )
        for row in rows:
            yield LogEvent(
                occurred_at=parse_instant(row["occurred_at"]),
                event_type=row["event_type"],
                listing_id="" if row["listing_id"] is None else str(row["listing_id"]),
                claim_id=None if row["claim_id"] is None else str(row["claim_id"]),
                actor_org_id=(None if row["actor_org_id"] is None else str(row["actor_org_id"])),
                payload=row["payload"],
            )

    def latest_event_at(self) -> datetime | None:
        row = self._rest.first("events", columns="occurred_at", order="occurred_at.desc")
        return None if row is None else parse_instant(row["occurred_at"])


def production_source(name: str) -> EventSource:
    """Resolve a `--source` CLI value to a source. Used by the batch job."""
    if name == "corpus":
        return CorpusEventSource()
    if name == "production":
        return ProductionEventSource()
    raise ValueError(f"unknown event source {name!r}; expected 'corpus' or 'production'")
