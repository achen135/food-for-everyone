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

## Why the production source is a stub rather than an unwritten file

`ProductionEventSource` raises, but it carries the query design in its
docstring, because that design is the part with the trap in it. A live log
cannot be replayed from the beginning per request; it has to be scoped, and
getting the scope wrong silently produces training/serving skew — the exact
failure `features_hash` exists to detect. Writing down what the scope has to
cover is most of the work, and losing it between milestones would be the
expensive part.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Protocol

from ml.db import connect
from ml.features.log import LogEvent, from_postgres

__all__ = ["CorpusEventSource", "EventSource", "ProductionEventSource"]


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
    """FFE's live `events` log. **M14.**

    Not implemented, and the reason it is not is worth more than the code would
    be. A live log cannot be replayed from the beginning on every request — the
    p99 target rules it out — so it has to be **scoped**, and the scope is not
    obvious. To reproduce `FeatureState`'s answers for one listing it must cover:

    - the target listing's own `listing_posted`, for every intrinsic feature;
    - **every event of every prior listing by the same donor**, for the
      `donor_prior_*` track record and `donor_median_claim_latency`;
    - every `listing_posted` by any donor within `MARKET_RADIUS_KM` whose
      pickup window has not closed, for `open_listings_within_15km`;
    - every `listing_claimed` in the trailing `CLAIM_WINDOW_HOURS` near the
      donor, for `claims_within_15km_prior_7d`;
    - and, awkwardly, **every `listing_claimed` whose recipient is within the
      radius, for the whole life of the log** — `recipients_within_*` is
      cumulative, and a recipient enters the index through the claim it made,
      whoever's listing that was.

    That last one is the reason this is M14 work and not a footnote here: it is
    unbounded in time, so it wants a maintained per-donor recipient count rather
    than a query, and that is a schema decision. It is also the single strongest
    argument for the `org_registered` event in `docs/ML Subsystem.md` §7 — with
    registrations in the log, recipient geography would be a bounded lookup
    instead of a scan over all history.

    Whatever this ends up doing, it connects **read-only and separately** from
    `ml.db.connect`. The corpus connection and every write stay behind the
    existing Supabase guard.
    """

    def replay(self, until: datetime | None) -> Iterator[LogEvent]:
        raise NotImplementedError(
            "the production event source is M14; see this class's docstring for the "
            "query scope it has to cover"
        )

    def latest_event_at(self) -> datetime | None:
        raise NotImplementedError("the production event source is M14")
