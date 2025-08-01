"""Reading the event log into memory.

Both the streaming pipeline and the reference implementation work on
`LogEvent`s, so they cannot disagree because one of them parsed a timestamp
differently. Sources: a live corpus database, a JSONL stream, or an in-process
`Event` iterator (which is what the tests use, so they need no database).
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ml.events import Event, parse_instant

__all__ = ["LogEvent", "from_events", "from_jsonl", "from_postgres", "sorted_log"]


@dataclass(frozen=True, slots=True)
class LogEvent:
    """One row of `public.events`, with instants already parsed.

    `listing_id` and the org ids stay strings. The ml side treats them as opaque
    — the log has no foreign keys and is meant to outlive the rows it describes
    (see Design Decisions, "The event log has no foreign keys"), so there is
    nothing to resolve them against and no reason to pay for UUID objects.
    """

    occurred_at: datetime
    event_type: str
    listing_id: str
    claim_id: str | None
    actor_org_id: str | None
    payload: dict[str, Any]

    def instant(self, key: str) -> datetime | None:
        """A payload timestamp, parsed. `None` if absent or null."""
        raw = self.payload.get(key)
        return None if raw is None else parse_instant(raw)


def from_events(events: Iterable[Event]) -> Iterator[LogEvent]:
    """Adapt the simulator's own output without a database round trip."""
    for event in events:
        yield LogEvent(
            occurred_at=event.occurred_at,
            event_type=event.event_type,
            listing_id="" if event.listing_id is None else str(event.listing_id),
            claim_id=None if event.claim_id is None else str(event.claim_id),
            actor_org_id=None if event.actor_org_id is None else str(event.actor_org_id),
            payload=event.payload,
        )


def from_jsonl(path: str | Path) -> Iterator[LogEvent]:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            yield LogEvent(
                occurred_at=parse_instant(row["occurred_at"]),
                event_type=row["event_type"],
                listing_id=row["listing_id"] or "",
                claim_id=row["claim_id"],
                actor_org_id=row["actor_org_id"],
                payload=row["payload"],
            )


def from_postgres(conn: Any, batch: int = 50_000) -> Iterator[LogEvent]:
    """Stream the log in `(occurred_at, id)` order — the forward cursor the
    index `events_occurred_at_idx` exists for.

    A server-side cursor rather than one big fetch: the corpus is ~309k rows and
    would fit in memory, but the pipeline is written to stream so that the same
    code works against a production log that will not.
    """
    with conn.cursor(name="events_scan") as cursor:
        cursor.itersize = batch
        cursor.execute(
            "select occurred_at, event_type, listing_id, claim_id, actor_org_id, payload "
            "from public.events order by occurred_at, id"
        )
        for occurred_at, event_type, listing_id, claim_id, actor_org_id, payload in cursor:
            yield LogEvent(
                occurred_at=occurred_at,
                event_type=event_type,
                listing_id="" if listing_id is None else str(listing_id),
                claim_id=None if claim_id is None else str(claim_id),
                actor_org_id=None if actor_org_id is None else str(actor_org_id),
                payload=payload,
            )


def sorted_log(events: Iterable[LogEvent]) -> list[LogEvent]:
    """Materialise in chronological order.

    `sorted` is stable, so events already in insertion order keep it within a
    tied instant — which matters: the corpus can contain two events at the same
    microsecond, and the pipeline's answers must not depend on how they were
    handed over.
    """
    return sorted(events, key=lambda event: event.occurred_at)
