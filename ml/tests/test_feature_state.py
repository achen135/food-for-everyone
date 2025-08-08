"""`FeatureState` — the object the batch pipeline and the serving path share.

`test_leakage.py` already proves the *values* are point-in-time correct, and it
kept passing unchanged through the refactor that extracted this class, which is
the evidence that the extraction preserved semantics. What is tested here is the
part the batch pipeline never exercises: **taking a snapshot at an `as_of` later
than the last event in the log**.

That is the serving case, and it is not the same as "state as of the last
event". A listing scored at 14:00 when the last thing that happened was at 09:00
must see five fewer hours on the clock, must not count a neighbour whose pickup
window shut at 11:00, and must have dropped claims that aged out of the trailing
seven-day window in between. Nothing in the log says any of that happened —
expiry emits no event — so if `advance_to` did not exist, every one of those
features would be frozen at 09:00 and the serving path would quietly disagree
with the training data.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from ml.features.log import LogEvent
from ml.features.pipeline import FeatureState, StaleSnapshotError, build_observations
from ml.features.spec import CLAIM_WINDOW_HOURS

T0 = datetime.fromisoformat("2025-03-01T08:00:00+00:00")
DONOR_A = "11111111-1111-4111-8111-111111111111"
DONOR_B = "aaaaaaaa-1111-4111-8111-111111111111"
RECIPIENT = "22222222-2222-4222-8222-222222222222"


def _hours(n: float) -> timedelta:
    return timedelta(hours=n)


def _posted(
    listing_id: str,
    at: datetime,
    *,
    donor: str = DONOR_A,
    window_hours: float = 8.0,
    lat: float = 41.88,
    lng: float = -87.63,
) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_posted",
        listing_id=listing_id,
        claim_id=None,
        actor_org_id=donor,
        payload={
            "donor_org_id": donor,
            "donor_lat": lat,
            "donor_lng": lng,
            "donor_verified": True,
            "title": "Day-old bread",
            "quantity": "12 trays",
            "notes_length": 40,
            "pickup_start": (at + _hours(1)).isoformat(),
            "pickup_end": (at + _hours(window_hours)).isoformat(),
        },
    )


def _claimed(listing_id: str, at: datetime, *, donor: str = DONOR_A) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_claimed",
        listing_id=listing_id,
        claim_id="44444444-4444-4444-8444-444444444444",
        actor_org_id=RECIPIENT,
        payload={
            "donor_org_id": donor,
            "recipient_org_id": RECIPIENT,
            "recipient_lat": 41.90,
            "recipient_lng": -87.62,
            "distance_km": 2.3,
        },
    )


def _state(events: list[LogEvent]) -> FeatureState:
    state = FeatureState()
    for event in events:
        state.apply(event)
    return state


# -- the clock moves even when the log does not -----------------------------


def test_as_of_relative_features_track_a_clock_with_no_new_events() -> None:
    state = _state([_posted("listing-1", T0, window_hours=8.0)])

    at_post = state.snapshot("listing-1", T0)
    later = state.snapshot("listing-1", T0 + _hours(5))

    assert at_post["hours_to_pickup_end"] == pytest.approx(8.0)
    assert later["hours_to_pickup_end"] == pytest.approx(3.0)
    assert at_post["hours_since_posted"] == pytest.approx(0.0)
    assert later["hours_since_posted"] == pytest.approx(5.0)
    assert at_post["as_of_hour"] == 8
    assert later["as_of_hour"] == 13


def test_a_neighbour_stops_counting_when_its_window_shuts() -> None:
    """`open_listings_within_15km` decays with no event to say so.

    Expiry emits nothing. Without `advance_to`, a listing posted this morning
    would still be counted as competition next week.
    """
    events = [
        _posted("listing-1", T0, window_hours=48.0),
        # Same donor, so certainly within 15 km, and a window that shuts first.
        _posted("listing-2", T0, window_hours=6.0),
    ]
    state = _state(events)

    while_both_open = state.snapshot("listing-1", T0 + _hours(5))
    after_the_other_shuts = state.snapshot("listing-1", T0 + _hours(7))

    assert while_both_open["open_listings_within_15km"] == 1
    assert after_the_other_shuts["open_listings_within_15km"] == 0


def test_a_neighbour_still_counts_at_the_exact_instant_it_shuts() -> None:
    """The tie-break the batch pipeline used, preserved.

    A close at `pickup_end` sorted *after* an observation at that same instant,
    so an observation at exactly `pickup_end` still saw the neighbour. The
    leakage guard is sensitive to this; it is asserted here so a future
    simplification to `<=` fails loudly rather than shifting one row in ten
    thousand.
    """
    state = _state(
        [
            _posted("listing-1", T0, window_hours=48.0),
            _posted("listing-2", T0, window_hours=6.0),
        ]
    )
    at_the_instant = state.snapshot("listing-1", T0 + _hours(6))
    assert at_the_instant["open_listings_within_15km"] == 1


def test_the_trailing_claim_window_expires_with_the_clock() -> None:
    events = [
        _posted("listing-1", T0, window_hours=24.0 * 30),
        _posted("listing-2", T0, window_hours=24.0 * 30),
        _claimed("listing-2", T0 + _hours(1)),
    ]
    state = _state(events)

    inside = state.snapshot("listing-1", T0 + _hours(CLAIM_WINDOW_HOURS))
    outside = state.snapshot("listing-1", T0 + _hours(CLAIM_WINDOW_HOURS + 2))

    assert inside["claims_within_15km_prior_7d"] == 1
    assert outside["claims_within_15km_prior_7d"] == 0


def test_recipient_geography_does_not_decay() -> None:
    """A recipient seen once stays visible; only the two windows expire.

    Worth pinning: `recipients_within_*` is cumulative by construction, which is
    exactly the property that makes it a lossy proxy for real coverage (the log
    has no organization-registration event). If it started decaying, the feature
    would mean something different from what the training data means.
    """
    state = _state(
        [
            _posted("listing-1", T0, window_hours=24.0 * 60),
            _posted("listing-2", T0, window_hours=24.0 * 60),
            _claimed("listing-2", T0 + _hours(1)),
        ]
    )
    assert state.snapshot("listing-1", T0 + _hours(1))["recipients_within_5km"] == 1
    assert state.snapshot("listing-1", T0 + _hours(24 * 45))["recipients_within_5km"] == 1


# -- guards -----------------------------------------------------------------


def test_snapshot_refuses_an_as_of_the_log_has_already_passed() -> None:
    """The serving-side leakage guard.

    Building state from events up to 10:00 and then asking about 09:00 would
    answer with an hour of the future folded in. The batch pipeline cannot
    reach this — it only applies an event when it is due — but a serving path
    that queried the wrong window would, and silently.
    """
    state = _state([_posted("listing-1", T0), _claimed("listing-1", T0 + _hours(2))])

    with pytest.raises(StaleSnapshotError, match="precedes the last applied event"):
        state.snapshot("listing-1", T0 + _hours(1))


def test_snapshot_of_an_unknown_listing_raises() -> None:
    state = _state([_posted("listing-1", T0)])
    with pytest.raises(KeyError):
        state.snapshot("listing-does-not-exist", T0)

    assert "listing-1" in state
    assert "listing-does-not-exist" not in state


# -- the two callers agree --------------------------------------------------


def test_snapshot_reproduces_what_the_batch_pipeline_emitted() -> None:
    """The claim that makes "same functions as the pipeline" true.

    Runs the batch pipeline over a log, then rebuilds the state independently
    and snapshots each observation's `(listing, as_of)`. Any disagreement is
    training/serving skew, which is the thing `features_hash` exists to catch in
    production and which is cheaper to catch here.
    """
    events = [
        _posted("listing-1", T0, window_hours=10.0),
        _posted("listing-2", T0 + _hours(1), window_hours=9.0),
        _posted("listing-3", T0 + _hours(2), donor=DONOR_B, lat=41.95, lng=-87.70),
        _claimed("listing-2", T0 + _hours(3)),
        _posted("listing-4", T0 + _hours(4), window_hours=12.0),
    ]

    observations = list(build_observations(iter(events)))
    assert observations, "the fixture should produce observations"

    for observation in observations:
        # A fresh state per observation, fed only the events that precede it —
        # which is what the serving path does for a single request.
        state = FeatureState()
        for event in events:
            if event.occurred_at <= observation.as_of:
                state.apply(event)
        assert state.snapshot(observation.listing_id, observation.as_of) == observation.features
