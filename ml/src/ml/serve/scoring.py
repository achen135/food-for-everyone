"""Replaying a log into `FeatureState`, and scoring against the committed model.

## Features via the same functions as the pipeline

M13's brief requires the endpoint to compute features "via the **same
functions** as the pipeline", and this is the file where that is either true or
a claim. It is true structurally: there is one `FeatureState`, the batch
pipeline drives it through `build_observations` and this service drives it
through `replay` + `snapshot`, and `ml/tests/test_feature_state.py` asserts that
rebuilding state from the events preceding an observation reproduces the exact
feature dict the batch pipeline emitted for it.

## Why the log is replayed once, at startup

The corpus is static and `FeatureState` is monotone in time, so the service
folds every event up to a **cursor** into one state when it starts and then
answers requests from it. A full replay per request would cost seconds and make
the p99 target meaningless.

The consequence is the API's one sharp edge, and it is deliberate: the service
can score at any `as_of` **at or after** its cursor, and cannot go back. Later
is fine and is the normal case — `advance_to` decays the clock-relative and
trailing-window features with no new event, which is exactly what scoring a
listing "right now" against a slightly stale log means. Earlier is refused,
because the state has already seen past that instant and the answer would have
the future folded into it. That refusal is `FeatureState.snapshot`'s own guard
surfacing as a 422 rather than a second, weaker check bolted on here.

## The cursor

Defaults to the newest event in the log — for the corpus, `2025-07-07`. Set
`ML_SERVE_AS_OF` to replay to a different instant, which is what the k6 script
does: it needs an instant with a healthy population of open listings to score,
and the very end of a corpus has few.

**Never `now`.** The corpus ends in July 2025, so a real wall-clock `as_of`
makes `hours_to_pickup_end` large and negative and every listing reads as long
expired. That is why `as_of` is a required request field rather than defaulting
to the current time.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ml.db import connection_pool
from ml.features.digest import features_hash
from ml.features.pipeline import FeatureState, StaleSnapshotError
from ml.features.spec import FEATURE_NAMES
from ml.model.artifact import ModelA, load_model_a
from ml.serve.sources import CorpusEventSource, EventSource

__all__ = [
    "ListingNotOpenError",
    "ScoreResult",
    "ScoringService",
    "StaleAsOfError",
    "UnknownListingError",
]


class UnknownListingError(LookupError):
    """No `listing_posted` for this listing at or before the cursor."""


class StaleAsOfError(ValueError):
    """`as_of` precedes the instant the service's state was built to."""


class ListingNotOpenError(ValueError):
    """The listing is not on offer at `as_of`, so the model was never asked this.

    Every training row came from a listing that was open and before its
    `pickup_end`. A claimed, completed, withdrawn or expired listing is out of
    distribution, and the model would still return a confident number for it.
    Refusing is the honest answer, and it keeps `predictions` free of rows that
    no evaluation covers.
    """


@dataclass(frozen=True, slots=True)
class ScoreResult:
    listing_id: str
    as_of: datetime
    score: float
    risk_tier: str
    model_version: str
    features_hash: str
    features: dict[str, Any]


class ScoringService:
    """One warm `FeatureState`, one loaded model, one pool for `predictions`."""

    def __init__(
        self,
        source: EventSource | None = None,
        model: ModelA | None = None,
        cursor: datetime | None = None,
        *,
        log_predictions: bool = True,
        dsn: str | None = None,
    ) -> None:
        self._source = source if source is not None else CorpusEventSource(dsn)
        self._model = model if model is not None else load_model_a()
        self._requested_cursor = cursor if cursor is not None else _configured_cursor()
        self._log_predictions = log_predictions
        self._dsn = dsn
        self._state = FeatureState()
        self._pool: Any = None
        self.cursor: datetime | None = None
        self.events_replayed = 0
        self.ready = False

    # -- lifecycle ----------------------------------------------------------

    def warm(self) -> None:
        """Replay the log to the cursor. Called once, at startup."""
        cursor = self._requested_cursor
        if cursor is None:
            cursor = self._source.latest_event_at()
        if cursor is None:
            raise RuntimeError(
                "the event log is empty; run `make data` before starting the service"
            )

        state = FeatureState()
        replayed = 0
        for event in self._source.replay(cursor):
            state.apply(event)
            replayed += 1

        # `advance_to` after the last event so listings whose windows closed
        # between that event and the cursor are already shut. Without it the
        # first request would be the one paying for it, and a service that
        # answers differently depending on whether it has been asked yet is a
        # bad service.
        state.advance_to(cursor)

        self._state = state
        self.cursor = cursor
        self.events_replayed = replayed
        if self._log_predictions:
            self._pool = connection_pool(self._dsn)
        self.ready = True

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()
            self._pool = None
        self.ready = False

    # -- scoring ------------------------------------------------------------

    def score(self, listing_id: str, as_of: datetime) -> ScoreResult:
        if self.cursor is not None and as_of < self.cursor:
            raise StaleAsOfError(
                f"as_of {as_of.isoformat()} precedes this service's replay cursor "
                f"{self.cursor.isoformat()}; the state has already seen past it"
            )
        if listing_id not in self._state:
            raise UnknownListingError(listing_id)
        if not self._state.is_open(listing_id, as_of):
            listing = self._state.listing(listing_id)
            assert listing is not None
            state = "expired" if as_of >= listing.pickup_end else listing.status
            raise ListingNotOpenError(
                f"listing {listing_id} is {state} at {as_of.isoformat()}, not open; "
                "the model is only trained on open-listing observations"
            )

        try:
            features = self._state.snapshot(listing_id, as_of)
        except StaleSnapshotError as error:  # pragma: no cover - guarded above
            raise StaleAsOfError(str(error)) from error

        digest = features_hash(features)
        scores = self._model.score(self._model.vector(features))
        score = float(scores[0])
        tier = str(self._model.tier(scores)[0])

        result = ScoreResult(
            listing_id=listing_id,
            as_of=as_of,
            score=score,
            risk_tier=tier,
            model_version=self._model.model_version,
            features_hash=digest,
            features=features,
        )
        self._record(result)
        return result

    def _record(self, result: ScoreResult) -> None:
        """Insert one `predictions` row.

        Synchronous, which is the simple reading of the brief's "every score
        inserts a `predictions` row" and is what makes the round trip
        assertable in a test. A production system would batch these off the
        request path; on a local Postgres the insert is a fraction of a
        millisecond and the k6 run measures it either way rather than hiding it.
        """
        if self._pool is None:
            return
        with self._pool.connection() as conn:
            conn.execute(
                "insert into public.predictions "
                "(listing_id, model_version, score, features_hash) values (%s, %s, %s, %s)",
                (result.listing_id, result.model_version, result.score, result.features_hash),
            )

    # -- health -------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        database = "skipped" if self._pool is None else "unreachable"
        if self._pool is not None:
            try:
                with self._pool.connection() as conn:
                    conn.execute("select 1")
                database = "ok"
            except Exception:
                # A health endpoint reports; it does not raise. Any failure to
                # reach the database is the answer, not an error.
                database = "unreachable"

        healthy = self.ready and database in {"ok", "skipped"}
        return {
            "status": "ok" if healthy else "degraded",
            "model_loaded": True,
            "model_version": self._model.model_version,
            "features": len(FEATURE_NAMES),
            "database": database,
            "replay_cursor": None if self.cursor is None else self.cursor.isoformat(),
            "events_replayed": self.events_replayed,
        }

    def open_listings(self, as_of: datetime | None = None) -> list[str]:
        """Every listing on offer at `as_of` (default: the replay cursor)."""
        when = as_of if as_of is not None else self.cursor
        assert when is not None, "the service has not been warmed"
        return self._state.open_listings(when)

    @property
    def model(self) -> ModelA:
        return self._model


def _configured_cursor() -> datetime | None:
    raw = os.environ.get("ML_SERVE_AS_OF")
    if not raw:
        return None
    parsed = datetime.fromisoformat(raw)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def timed(fn: Any, *args: Any, **kwargs: Any) -> tuple[Any, float]:
    started = time.perf_counter()
    value = fn(*args, **kwargs)
    return value, time.perf_counter() - started
