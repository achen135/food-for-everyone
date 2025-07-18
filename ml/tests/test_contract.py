"""Every emitted row matches the `events` payload contract.

The contract's source of truth is
`supabase/migrations/20260909201144_events_append_only.sql`; `ml.events`
encodes it and `ml/sql/001_events.sql` mirrors the table. These tests are what
turns that three-way coupling from a comment into something that fails.
"""

from __future__ import annotations

import collections
from datetime import datetime
from uuid import UUID, uuid4

import pytest

from ml.events import (
    ACTOR_ROLE,
    CLAIM_ID_REQUIRED,
    EVENT_TYPES,
    NULLABLE_PAYLOAD_KEYS,
    PAYLOAD_KEYS,
    ContractError,
    Event,
    format_instant,
    parse_instant,
    validate_event,
)

# -- the generated stream ---------------------------------------------------


def test_all_five_event_types_are_present(short_run) -> None:  # type: ignore[no-untyped-def]
    """Including `listing_cancelled`, the type the brief did not ask for.

    It exists because a donor withdrawing an unclaimed listing has no honest
    home among the other four, and the label depends on telling that apart from
    food nobody took. A corpus missing it would not exercise the distinction.
    """
    seen = collections.Counter(e["event_type"] for e in short_run.events)
    for event_type in EVENT_TYPES:
        assert seen[event_type] > 0, f"no {event_type} in the corpus"


def test_payload_keys_match_the_contract_exactly(short_run) -> None:  # type: ignore[no-untyped-def]
    """Exact, not minimal: an extra key is as much a failure as a missing one.

    Production builds each payload with a literal `jsonb_build_object`, so it
    emits these keys and no others. A simulator that added a convenient extra
    would hand M12 a feature that is absent on real data.
    """
    for event in short_run.events:
        event_type = event["event_type"]
        assert tuple(sorted(event["payload"])) == PAYLOAD_KEYS[event_type], event_type


def test_non_nullable_payload_values_are_populated(short_run) -> None:  # type: ignore[no-untyped-def]
    for event in short_run.events:
        event_type = event["event_type"]
        nullable = NULLABLE_PAYLOAD_KEYS[event_type]
        for key, value in event["payload"].items():
            if key not in nullable:
                assert value is not None, f"{event_type}.{key} was null"


def test_pickup_end_is_on_every_event(short_run) -> None:  # type: ignore[no-untyped-def]
    """The label-critical field. "Posted, `pickup_end` passed, never claimed" is
    the whole definition of the positive class, so a row without it is not a
    slightly worse row — it is an unlabellable one."""
    for event in short_run.events:
        pickup_end = event["payload"].get("pickup_end")
        assert isinstance(pickup_end, str)
        parse_instant(pickup_end)


def test_no_free_text_notes_ever_leave_the_simulator(short_run) -> None:  # type: ignore[no-untyped-def]
    """`notes_length`, never `notes`.

    The length is the feature (how much detail a donor wrote); the text is
    donor-authored free-form and the likeliest place for an incidental phone
    number to end up. This mirrors the rule the production migration enforces.
    """
    for event in short_run.events:
        assert "notes" not in event["payload"]
    posted = [e for e in short_run.events if e["event_type"] == "listing_posted"]
    assert posted
    for event in posted:
        assert isinstance(event["payload"]["notes_length"], int)
        assert event["payload"]["notes_length"] >= 0


def test_ids_are_uuids_and_claim_ids_appear_only_where_they_should(short_run) -> None:  # type: ignore[no-untyped-def]
    for event in short_run.events:
        UUID(event["listing_id"])
        UUID(event["actor_org_id"])
        if event["event_type"] in CLAIM_ID_REQUIRED:
            UUID(event["claim_id"])


def test_actor_matches_the_side_that_performs_the_transition(short_run) -> None:  # type: ignore[no-untyped-def]
    """`claim_completed` is the donor's event, not the recipient's — the donor
    marks a pickup collected. Getting this backwards would be invisible in the
    row counts and wrong in every per-org feature M12 builds."""
    for event in short_run.events:
        role = ACTOR_ROLE[event["event_type"]]
        expected = event["payload"][f"{role}_org_id"]
        assert event["actor_org_id"] == expected, event["event_type"]


def test_listing_cancelled_displaced_fields_are_all_or_nothing(short_run) -> None:  # type: ignore[no-untyped-def]
    """A withdrawal either displaced a claim or it did not. Three keys half
    populated would mean the engine lost track of the claim it was closing."""
    rows = [e for e in short_run.events if e["event_type"] == "listing_cancelled"]
    assert rows
    populated = 0
    for event in rows:
        payload = event["payload"]
        present = [
            payload["displaced_claim_id"] is not None,
            payload["displaced_recipient_org_id"] is not None,
            payload["displaced_claimed_at"] is not None,
        ]
        assert len(set(present)) == 1, payload
        if present[0]:
            populated += 1
            assert event["claim_id"] == payload["displaced_claim_id"]
        else:
            assert event["claim_id"] is None
    assert populated > 0, "no withdrawal ever displaced a claim; the case is untested"


def test_events_are_ordered_and_causally_consistent(short_run) -> None:  # type: ignore[no-untyped-def]
    """`occurred_at` never goes backwards, and nothing happens to a listing
    before it was posted.

    Ordering is not cosmetic. The ml side reads with `(occurred_at, id)` as a
    forward cursor, and every as-of feature in M12 assumes the log is a
    chronology. A claim that sorted before its own listing would let a feature
    "see" an event that had not happened.
    """
    previous: str | None = None
    posted_at: dict[str, str] = {}
    for event in short_run.events:
        occurred_at = event["occurred_at"]
        if previous is not None:
            assert occurred_at >= previous
        previous = occurred_at

        listing_id = event["listing_id"]
        if event["event_type"] == "listing_posted":
            posted_at[listing_id] = occurred_at
        else:
            assert listing_id in posted_at, "event for a listing that was never posted"
            assert occurred_at >= posted_at[listing_id]


def test_claims_carry_a_distance_consistent_with_their_coordinates(short_run) -> None:  # type: ignore[no-untyped-def]
    from ml.simulate.geo import haversine_km

    rows = [e for e in short_run.events if e["event_type"] == "listing_claimed"]
    assert rows
    for event in rows[:500]:
        payload = event["payload"]
        expected = haversine_km(
            payload["donor_lat"],
            payload["donor_lng"],
            payload["recipient_lat"],
            payload["recipient_lng"],
        )
        assert abs(payload["distance_km"] - expected) < 1e-3


def test_pickup_window_is_always_positive(short_run) -> None:  # type: ignore[no-untyped-def]
    """`create_listing` returns `bad_window` unless `pickup_end > pickup_start`,
    so production cannot contain an inverted window and neither may this."""
    for event in short_run.events:
        payload = event["payload"]
        if "pickup_start" in payload:
            assert parse_instant(payload["pickup_end"]) > parse_instant(payload["pickup_start"])


# -- the validator itself ---------------------------------------------------


def _valid_posted() -> Event:
    now = datetime.fromisoformat("2025-03-01T12:00:00+00:00")
    donor = uuid4()
    return Event(
        occurred_at=now,
        event_type="listing_posted",
        listing_id=uuid4(),
        claim_id=None,
        actor_org_id=donor,
        payload={
            "donor_org_id": str(donor),
            "donor_lat": 41.88,
            "donor_lng": -87.63,
            "donor_verified": True,
            "title": "Day-old bread",
            "quantity": "8 trays",
            "notes_length": 42,
            "pickup_start": format_instant(now),
            "pickup_end": format_instant(now),
        },
    )


def test_validator_accepts_a_well_formed_event() -> None:
    validate_event(_valid_posted())


def test_validator_rejects_a_missing_key() -> None:
    event = _valid_posted()
    del event.payload["quantity"]
    with pytest.raises(ContractError, match="missing"):
        validate_event(event)


def test_validator_rejects_an_unknown_key() -> None:
    event = _valid_posted()
    event.payload["donor_rating"] = 4.5
    with pytest.raises(ContractError, match="unexpected"):
        validate_event(event)


def test_validator_rejects_note_text() -> None:
    event = _valid_posted()
    event.payload["notes"] = "call Dave on 555-0134"
    with pytest.raises(ContractError):
        validate_event(event)


def test_validator_rejects_a_naive_timestamp() -> None:
    event = _valid_posted()
    naive = Event(
        occurred_at=datetime(2025, 3, 1, 12, 0, 0),
        event_type=event.event_type,
        listing_id=event.listing_id,
        claim_id=None,
        actor_org_id=event.actor_org_id,
        payload=event.payload,
    )
    with pytest.raises(ContractError, match="timezone-aware"):
        validate_event(naive)


def test_validator_rejects_a_wrong_cancelled_by() -> None:
    donor = uuid4()
    event = Event(
        occurred_at=datetime.fromisoformat("2025-03-01T12:00:00+00:00"),
        event_type="listing_cancelled",
        listing_id=uuid4(),
        claim_id=None,
        actor_org_id=donor,
        payload={
            "donor_org_id": str(donor),
            "pickup_end": "2025-03-01T18:00:00.000000+00:00",
            "cancelled_by": "recipient",  # wrong: a withdrawal is the donor's
            "displaced_claim_id": None,
            "displaced_recipient_org_id": None,
            "displaced_claimed_at": None,
        },
    )
    with pytest.raises(ContractError, match="cancelled_by"):
        validate_event(event)


def test_format_instant_always_has_six_digit_microseconds() -> None:
    """Otherwise the byte-identical claim would depend on whether a simulated
    timestamp happened to land on a whole second."""
    whole = datetime.fromisoformat("2025-03-01T12:00:00+00:00")
    assert format_instant(whole) == "2025-03-01T12:00:00.000000+00:00"
    assert len(format_instant(whole)) == len(
        format_instant(datetime.fromisoformat("2025-03-01T12:00:00.123456+00:00"))
    )
