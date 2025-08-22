"""Where a batch run's risk tiers land.

Two destinations, one protocol. Which one a run uses is **derived from its
event source, never chosen independently** — see `writer_for`.

## `listing_risk` is current state, not a log

One row per listing, primary key `listing_id`. The app asks "what is this
listing's risk right now"; the history of how that answer moved lives in
`predictions`, which the scoring path already writes per score. Two consequences
follow, and both are decisions the M14 brief left open:

**Closed listings are deleted, not left stale.** A listing past its pickup
window, or claimed, has no risk left to report — the question resolved itself.
Leaving the row would let the web hook badge a listing that is no longer open,
and because that hook is built to fail *silently* (flag off, table absent, no
row → render as today), nothing downstream would ever flag the staleness. A
missing row is the one state the reader already handles correctly, so that is
the state a closed listing gets. `prune` does it.

**`scored_at` is the run's `as_of`, not `now()`.** This is what makes a re-run
genuinely idempotent rather than idempotent-except-one-column: the same events
plus the same model plus the same `as_of` produce byte-identical rows, so the
"a second run changes nothing" test can assert exactly that. It is also the
more useful reading of the column — the risk is a statement about an instant,
and for a production run (`as_of = now`) the two coincide anyway.

## The write path's blast radius

`ListingRiskWriter` is the **only** ml→Supabase write in the whole subsystem.
It names one table in one constant and has no method that takes a table name,
so widening it takes an edit here rather than a misconfigured environment
variable. `ml.db`'s refusal of a Supabase DSN is untouched and stays untouched;
this is a separate door, not a loosened one.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from ml.db import connect
from ml.supabase_rest import SupabaseConfig, SupabaseRest

__all__ = [
    "CorpusRiskWriter",
    "ListingRiskWriter",
    "RiskRow",
    "RiskWriter",
    "writer_for",
]

#: The single table this module is allowed to write. Not a parameter anywhere.
RISK_TABLE = "listing_risk"

#: PostgREST puts filters in the URL, so an `in.(…)` list of ids has to stay
#: short enough not to trip a request-line limit. 100 uuids is ~3.7 kB.
DELETE_CHUNK = 100


@dataclass(frozen=True, slots=True)
class RiskRow:
    """One listing's current risk, as both destinations store it."""

    listing_id: str
    risk_tier: str
    score: float
    model_version: str
    scored_at: datetime

    def as_json(self) -> dict[str, Any]:
        return {
            "listing_id": self.listing_id,
            "risk_tier": self.risk_tier,
            "score": self.score,
            "model_version": self.model_version,
            "scored_at": self.scored_at.isoformat(),
        }


class RiskWriter(Protocol):
    """A destination for a batch run's `listing_risk` rows."""

    @property
    def label(self) -> str:
        """Human-readable target, for the run report."""
        ...

    def upsert(self, rows: Sequence[RiskRow]) -> int:
        """Insert or replace by `listing_id`. Returns rows written."""
        ...

    def prune(self, keep: Iterable[str]) -> int:
        """Delete every row whose listing is not in `keep`. Returns rows removed."""
        ...

    def existing_ids(self) -> set[str]: ...


class CorpusRiskWriter:
    """`listing_risk` in the corpus Postgres (`ml/sql/002_ml_tables.sql`).

    Goes through `ml.db.connect`, so the Supabase refusal applies: a run
    configured with a corpus source can never write to production even if
    `ML_DATABASE_URL` is set to something wrong.
    """

    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    @property
    def label(self) -> str:
        return "corpus listing_risk"

    def upsert(self, rows: Sequence[RiskRow]) -> int:
        if not rows:
            return 0
        with connect(self._dsn) as conn:
            conn.cursor().executemany(
                "insert into public.listing_risk "
                "(listing_id, risk_tier, score, model_version, scored_at) "
                "values (%s, %s, %s, %s, %s) "
                "on conflict (listing_id) do update set "
                "risk_tier = excluded.risk_tier, "
                "score = excluded.score, "
                "model_version = excluded.model_version, "
                "scored_at = excluded.scored_at",
                [(r.listing_id, r.risk_tier, r.score, r.model_version, r.scored_at) for r in rows],
            )
        return len(rows)

    def existing_ids(self) -> set[str]:
        with connect(self._dsn) as conn:
            rows = conn.execute("select listing_id from public.listing_risk").fetchall()
        return {str(row[0]) for row in rows}

    def prune(self, keep: Iterable[str]) -> int:
        keep_set = set(keep)
        stale = self.existing_ids() - keep_set
        if not stale:
            return 0
        with connect(self._dsn) as conn:
            conn.execute(
                "delete from public.listing_risk where listing_id = any(%s)",
                (list(stale),),
            )
        return len(stale)


class ListingRiskWriter:
    """`public.listing_risk` in FFE production Supabase. The only ml→FFE write.

    The web app reads this table behind a feature flag; nothing else in the
    subsystem writes to production at all.
    """

    def __init__(self, config: SupabaseConfig | None = None) -> None:
        self._rest = SupabaseRest(config)

    @property
    def label(self) -> str:
        return f"production listing_risk ({self._rest.project_url})"

    def upsert(self, rows: Sequence[RiskRow]) -> int:
        if not rows:
            return 0
        self._rest.upsert(RISK_TABLE, [row.as_json() for row in rows], on_conflict="listing_id")
        return len(rows)

    def existing_ids(self) -> set[str]:
        return {
            str(row["listing_id"]) for row in self._rest.select(RISK_TABLE, columns="listing_id")
        }

    def prune(self, keep: Iterable[str]) -> int:
        keep_set = set(keep)
        stale = sorted(self.existing_ids() - keep_set)
        if not stale:
            return 0
        for start in range(0, len(stale), DELETE_CHUNK):
            chunk = stale[start : start + DELETE_CHUNK]
            joined = ",".join(chunk)
            self._rest.delete(RISK_TABLE, filters={"listing_id": f"in.({joined})"})
        return len(stale)


def writer_for(source_name: str, dsn: str | None = None) -> RiskWriter:
    """The destination that belongs to `source_name`.

    Deliberately not two independent flags. A run that replayed the **corpus**
    and wrote to **production** would put simulated listing ids into the table
    the live app reads — rows that match no real listing, arriving through the
    one code path allowed to write production. There is no legitimate use for
    that combination, so it is not expressible: the source picks the sink.
    """
    if source_name == "corpus":
        return CorpusRiskWriter(dsn)
    if source_name == "production":
        return ListingRiskWriter()
    raise ValueError(f"unknown event source {source_name!r}; expected 'corpus' or 'production'")
