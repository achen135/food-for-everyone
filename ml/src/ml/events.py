"""The `events` payload contract, in code.

`ml/sql/001_events.sql` mirrors the shape of the production table; this module
mirrors the shape of what goes *in* it. Both trace back to one source of truth:

    supabase/migrations/20260909201144_events_append_only.sql

Everything downstream — the simulator's sinks, M12's feature functions, M13's
serving path — goes through `Event` and `validate_event`, so a drift between
this file and that migration surfaces as a failing conformance test rather than
as a model quietly trained on a shape production stopped emitting.

## Why the key sets are exact, not minimal

`validate_event` rejects unknown keys as well as missing ones. That is
deliberate. The migration builds each payload with a literal
`jsonb_build_object`, so production emits exactly these keys and no others; a
simulator that added a helpful extra one would be handing the feature pipeline
a column that will be absent on real data — training/serving skew introduced at
the point where it is cheapest to prevent and hardest to notice later.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, Literal
from uuid import UUID

EventType = Literal[
    "listing_posted",
    "listing_claimed",
    "claim_completed",
    "claim_cancelled",
    "listing_cancelled",
]

#: In the order the check constraint lists them.
EVENT_TYPES: Final[tuple[EventType, ...]] = (
    "listing_posted",
    "listing_claimed",
    "claim_completed",
    "claim_cancelled",
    "listing_cancelled",
)

#: The exact payload keys per event type. Sorted tuples rather than sets: this
#: is a contract, and iterating it must be order-stable across processes.
PAYLOAD_KEYS: Final[dict[EventType, tuple[str, ...]]] = {
    "listing_posted": (
        "donor_lat",
        "donor_lng",
        "donor_org_id",
        "donor_verified",
        "notes_length",
        "pickup_end",
        "pickup_start",
        "quantity",
        "title",
    ),
    "listing_claimed": (
        "distance_km",
        "donor_lat",
        "donor_lng",
        "donor_org_id",
        "donor_verified",
        "pickup_end",
        "pickup_start",
        "recipient_lat",
        "recipient_lng",
        "recipient_org_id",
    ),
    "claim_completed": (
        "claimed_at",
        "donor_org_id",
        "pickup_end",
        "recipient_org_id",
    ),
    "claim_cancelled": (
        "cancelled_by",
        "claimed_at",
        "donor_org_id",
        "pickup_end",
        "recipient_org_id",
    ),
    "listing_cancelled": (
        "cancelled_by",
        "displaced_claim_id",
        "displaced_claimed_at",
        "displaced_recipient_org_id",
        "donor_org_id",
        "pickup_end",
    ),
}

#: Keys whose value may legitimately be null, per type. Everything else must be
#: present *and* non-null. The three `displaced_*` keys are null exactly when a
#: donor withdrew a listing nobody had claimed, which is the common case.
NULLABLE_PAYLOAD_KEYS: Final[dict[EventType, tuple[str, ...]]] = {
    "listing_posted": (),
    "listing_claimed": (),
    "claim_completed": (),
    "claim_cancelled": (),
    "listing_cancelled": (
        "displaced_claim_id",
        "displaced_claimed_at",
        "displaced_recipient_org_id",
    ),
}

#: Which side of the exchange performs each transition — `actor_org_id`.
#: `claim_completed` is the donor's: the donor marks a pickup collected.
ACTOR_ROLE: Final[dict[EventType, Literal["donor", "recipient"]]] = {
    "listing_posted": "donor",
    "listing_claimed": "recipient",
    "claim_completed": "donor",
    "claim_cancelled": "recipient",
    "listing_cancelled": "donor",
}

#: Types that must carry a non-null `claim_id`. `listing_cancelled` is absent on
#: purpose — a withdrawal of an unclaimed listing has no claim to name.
CLAIM_ID_REQUIRED: Final[tuple[EventType, ...]] = (
    "listing_claimed",
    "claim_completed",
    "claim_cancelled",
)

#: Payload keys carrying an ISO-8601 instant.
TIMESTAMP_PAYLOAD_KEYS: Final[frozenset[str]] = frozenset(
    {"pickup_start", "pickup_end", "claimed_at", "displaced_claimed_at"}
)

SCHEMA_VERSION: Final[int] = 1


class ContractError(ValueError):
    """An event does not match the payload contract."""


def format_instant(value: datetime) -> str:
    """Serialise an instant the one way this subsystem serialises instants.

    Fixed six-digit microseconds and an explicit ``+00:00``, always. Left to
    ``datetime.isoformat`` the microsecond field disappears whenever it happens
    to be zero, which makes the byte-identical determinism check depend on
    whether a simulated timestamp landed on a whole second.
    """
    if value.tzinfo is None:
        raise ContractError(f"naive datetime is not an instant: {value!r}")
    utc = value.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.%f") + "+00:00"


def parse_instant(value: str) -> datetime:
    """Inverse of `format_instant`, tolerant of Postgres' own rendering."""
    return datetime.fromisoformat(value).astimezone(UTC)


@dataclass(frozen=True, slots=True)
class Event:
    """One row of `public.events`.

    Field order matches the table's column order, which is also the order the
    COPY sink writes them in.
    """

    occurred_at: datetime
    event_type: EventType
    listing_id: UUID | None
    claim_id: UUID | None
    actor_org_id: UUID | None
    payload: dict[str, Any] = field(default_factory=dict)
    schema_version: int = SCHEMA_VERSION

    def to_record(self) -> dict[str, Any]:
        """A plain JSON-ready dict. Keys sorted by `to_json_line`, not here."""
        return {
            "occurred_at": format_instant(self.occurred_at),
            "event_type": self.event_type,
            "listing_id": None if self.listing_id is None else str(self.listing_id),
            "claim_id": None if self.claim_id is None else str(self.claim_id),
            "actor_org_id": None if self.actor_org_id is None else str(self.actor_org_id),
            "payload": self.payload,
            "schema_version": self.schema_version,
        }

    def to_json_line(self) -> str:
        """One JSONL line, byte-stable for a given event.

        `sort_keys` and the compact separators are what make "same seed →
        byte-identical stream" a checkable claim rather than a hope: without
        them the bytes would depend on dict insertion order, which depends on
        the order the generator happened to build the payload.
        """
        return json.dumps(
            self.to_record(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )


def validate_event(event: Event) -> None:
    """Raise `ContractError` unless `event` matches the contract exactly.

    Checks the shape, not the plausibility: it does not know whether a claim
    preceded its own listing. Ordering invariants are the simulator's own tests.
    """
    if event.event_type not in PAYLOAD_KEYS:
        raise ContractError(f"unknown event_type {event.event_type!r}")

    if event.occurred_at.tzinfo is None:
        raise ContractError(f"{event.event_type}: occurred_at must be timezone-aware")

    if event.schema_version != SCHEMA_VERSION:
        raise ContractError(
            f"{event.event_type}: schema_version {event.schema_version} != {SCHEMA_VERSION}"
        )

    # Every type is about a listing; only some are about a claim.
    if event.listing_id is None:
        raise ContractError(f"{event.event_type}: listing_id is required")
    if event.actor_org_id is None:
        raise ContractError(f"{event.event_type}: actor_org_id is required")
    if event.event_type in CLAIM_ID_REQUIRED and event.claim_id is None:
        raise ContractError(f"{event.event_type}: claim_id is required")

    expected = PAYLOAD_KEYS[event.event_type]
    actual = tuple(sorted(event.payload))
    if actual != expected:
        missing = [k for k in expected if k not in event.payload]
        extra = [k for k in actual if k not in expected]
        raise ContractError(
            f"{event.event_type}: payload keys mismatch"
            + (f"; missing {missing}" if missing else "")
            + (f"; unexpected {extra}" if extra else "")
        )

    nullable = NULLABLE_PAYLOAD_KEYS[event.event_type]
    for key in expected:
        value = event.payload[key]
        if value is None and key not in nullable:
            raise ContractError(f"{event.event_type}: payload[{key!r}] must not be null")
        if value is not None and key in TIMESTAMP_PAYLOAD_KEYS and not isinstance(value, str):
            raise ContractError(
                f"{event.event_type}: payload[{key!r}] must be an ISO-8601 string, "
                f"got {type(value).__name__}"
            )

    # `pickup_end` is the label-critical field: the derived label is "posted,
    # pickup_end passed, never claimed". A row missing it is not a slightly
    # worse row, it is an unlabellable one — so it is checked by name here as
    # well as by the key-set comparison above.
    if event.payload.get("pickup_end") is None:
        raise ContractError(f"{event.event_type}: pickup_end is required on every event")

    # `notes_length`, never the notes. The log leaves the product and is read by
    # another subsystem; donor free text is where an incidental phone number
    # ends up (see the migration header).
    if "notes" in event.payload:
        raise ContractError(f"{event.event_type}: payload carries note text, not just its length")

    if event.event_type == "claim_cancelled" and event.payload["cancelled_by"] != "recipient":
        raise ContractError("claim_cancelled: cancelled_by must be 'recipient'")
    if event.event_type == "listing_cancelled" and event.payload["cancelled_by"] != "donor":
        raise ContractError("listing_cancelled: cancelled_by must be 'donor'")
