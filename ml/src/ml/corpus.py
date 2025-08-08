"""Identifying the corpus a committed result was measured on.

`baselines.json` and `model_card.json` both claim to describe a particular event
log. This is how a reader tells whether the log on their disk is that one.

Not a hash of every row — a count, a span and a per-type breakdown, which is
what actually changes when someone regenerates with a different seed or a
different month count. `make reproduce` runs generation, features and evaluation
in order, so the three are normally in step; this is how a mismatch is noticed
when they are not.

Shared rather than copied. Two fingerprints of the same corpus that disagree
because one of them drifted would be worse than having no fingerprint at all.
"""

from __future__ import annotations

from typing import Any

import psycopg

__all__ = ["corpus_fingerprint"]


def corpus_fingerprint(conn: psycopg.Connection) -> dict[str, Any]:
    row = conn.execute(
        "select count(*), min(occurred_at), max(occurred_at), count(distinct listing_id) "
        "from public.events"
    ).fetchone()
    if row is None or row[1] is None:
        raise ValueError("the events table is empty — run `make data` first")
    total, first, last, listings = row
    by_type: dict[str, int] = {
        str(event_type): int(count)
        for event_type, count in conn.execute(
            "select event_type, count(*) from public.events group by 1 order by 1"
        )
    }
    return {
        "events": int(total),
        "listings": int(listings),
        "first_event": first.isoformat(),
        "last_event": last.isoformat(),
        "events_by_type": dict(sorted(by_type.items())),
    }
