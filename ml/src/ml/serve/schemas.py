"""The wire contract for `POST /score/waste`.

## `as_of` is required, and that is the interesting part

The obvious API takes a listing id and scores it "now". This one does not, and
the reason is in the data: **the corpus ends 2025-07-07.** Scoring at a real
wall-clock `now` would make `hours_to_pickup_end` a large negative number for
every listing in it, and the model — correctly — would report that every listing
in the world is doomed. A default of `now` would have made the benchmark
meaningless and the failure would have looked like a modelling problem.

Making the instant explicit also gives one endpoint two honest uses: the
historical benchmark drives it with in-corpus timestamps, and a live caller
passes its own `now`. M14's batch scorer is the second of those.

Naive datetimes are read as UTC rather than rejected. The event log is
`timestamptz` throughout and every instant in it is UTC, so there is one correct
interpretation; refusing the input would trade a clear default for a 422 that
tells the caller nothing it could not have guessed.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = ["HealthResponse", "ScoreRequest", "ScoreResponse"]


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    listing_id: UUID = Field(description="The listing to score.")
    as_of: datetime = Field(
        description=(
            "The instant to score at. REQUIRED — there is no 'now' default; the "
            "corpus ends 2025-07-07 and a wall-clock now would read as expired."
        )
    )

    @field_validator("as_of")
    @classmethod
    def _as_utc(cls, value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


class ScoreResponse(BaseModel):
    # `model_version` collides with pydantic's protected `model_` namespace,
    # which would emit a warning on every import. The field name is the one the
    # `predictions` table and the model card already use, so the namespace
    # gives way rather than the schema.
    model_config = ConfigDict(protected_namespaces=())

    listing_id: UUID
    as_of: datetime
    score: float = Field(description="Calibrated probability the listing expires unclaimed.")
    risk_tier: Literal["low", "medium", "high"]
    model_version: str
    features_hash: str = Field(
        description=(
            "Digest of the exact feature vector this score came from, for detecting "
            "training/serving skew after the fact."
        )
    )


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["ok", "degraded"]
    model_loaded: bool
    model_version: str
    features: int
    database: Literal["ok", "unreachable", "skipped"]
    replay_cursor: str | None
    events_replayed: int
