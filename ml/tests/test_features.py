"""Label derivation, observation cadence, and the two text features.

The label tests are built from hand-written events rather than a simulated
corpus. Each case is one sentence of product behaviour — "a donor pulled an
unclaimed offer", "a recipient handed it back and nobody else took it" — and
writing the events out by hand is the only way to be sure the case under test is
actually the case present in the data.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from itertools import pairwise

import pytest

from ml.features.labels import LabelIndex, LabelOutcome, build_label_index
from ml.features.log import LogEvent, from_events, sorted_log
from ml.features.pipeline import build_observations
from ml.features.reference import features_as_of
from ml.features.text import food_category, parse_quantity_units
from ml.simulate.config import SimulationConfig
from ml.simulate.engine import simulate
from ml.simulate.geo import haversine_km

T0 = datetime.fromisoformat("2025-03-01T08:00:00+00:00")
DONOR = "11111111-1111-4111-8111-111111111111"
RECIPIENT = "22222222-2222-4222-8222-222222222222"
LISTING = "33333333-3333-4333-8333-333333333333"
CLAIM = "44444444-4444-4444-8444-444444444444"


def _hours(n: float) -> timedelta:
    return timedelta(hours=n)


def _posted(pickup_end_hours: float = 8.0, at: datetime = T0) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_posted",
        listing_id=LISTING,
        claim_id=None,
        actor_org_id=DONOR,
        payload={
            "donor_org_id": DONOR,
            "donor_lat": 41.88,
            "donor_lng": -87.63,
            "donor_verified": True,
            "title": "Day-old bread",
            "quantity": "12 trays",
            "notes_length": 40,
            "pickup_start": (at + _hours(1)).isoformat(),
            "pickup_end": (at + _hours(pickup_end_hours)).isoformat(),
        },
    )


def _claimed(at: datetime) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_claimed",
        listing_id=LISTING,
        claim_id=CLAIM,
        actor_org_id=RECIPIENT,
        payload={
            "donor_org_id": DONOR,
            "donor_lat": 41.88,
            "donor_lng": -87.63,
            "donor_verified": True,
            "recipient_org_id": RECIPIENT,
            "recipient_lat": 41.90,
            "recipient_lng": -87.62,
            "distance_km": 2.3,
            "pickup_start": (T0 + _hours(1)).isoformat(),
            "pickup_end": (T0 + _hours(8)).isoformat(),
        },
    )


def _released(at: datetime) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="claim_cancelled",
        listing_id=LISTING,
        claim_id=CLAIM,
        actor_org_id=RECIPIENT,
        payload={
            "donor_org_id": DONOR,
            "recipient_org_id": RECIPIENT,
            "pickup_end": (T0 + _hours(8)).isoformat(),
            "claimed_at": (T0 + _hours(2)).isoformat(),
            "cancelled_by": "recipient",
        },
    )


def _withdrawn(at: datetime, displaced: bool = False) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_cancelled",
        listing_id=LISTING,
        claim_id=CLAIM if displaced else None,
        actor_org_id=DONOR,
        payload={
            "donor_org_id": DONOR,
            "pickup_end": (T0 + _hours(8)).isoformat(),
            "cancelled_by": "donor",
            "displaced_claim_id": CLAIM if displaced else None,
            "displaced_recipient_org_id": RECIPIENT if displaced else None,
            "displaced_claimed_at": (T0 + _hours(2)).isoformat() if displaced else None,
        },
    )


def _index(events: list[LogEvent], corpus_end_hours: float = 48.0) -> LabelIndex:
    """Build a label index, padding the log so `corpus_end` is well past the
    listing unless a test is specifically about censoring."""
    padding = LogEvent(
        occurred_at=T0 + _hours(corpus_end_hours),
        event_type="listing_posted",
        listing_id="99999999-9999-4999-8999-999999999999",
        claim_id=None,
        actor_org_id=DONOR,
        payload={**_posted().payload, "donor_org_id": DONOR},
    )
    return build_label_index(sorted_log([*events, padding]))


# -- the label ---------------------------------------------------------------


def test_never_claimed_and_window_closed_is_wasted() -> None:
    index = _index([_posted()])
    label, reason = index.label(LISTING, T0 + _hours(1))
    assert (label, reason) == (1, LabelOutcome.WASTED)


def test_claim_after_as_of_is_not_wasted() -> None:
    index = _index([_posted(), _claimed(T0 + _hours(2))])
    label, reason = index.label(LISTING, T0 + _hours(1))
    assert (label, reason) == (0, LabelOutcome.CLAIMED)


def test_withdrawn_while_unclaimed_is_dropped_not_labelled() -> None:
    """The reason M10 emitted a fifth event type its own brief did not ask for.

    A donor who pulls an unclaimed offer — sold it, posted it twice — did not
    waste food. Counting them as positives would bake false positives into the
    training labels with nothing in the log to contradict them.
    """
    index = _index([_posted(), _withdrawn(T0 + _hours(3))])
    label, reason = index.label(LISTING, T0 + _hours(1))
    assert label is None
    assert reason == LabelOutcome.WITHDRAWN


def test_withdrawal_that_displaced_a_claim_does_not_drop_earlier_observations() -> None:
    """A withdrawal that took food off somebody is a different situation.

    The observations before the claim already carry label 0 from that claim, and
    nothing about them is unlabellable.
    """
    events = [_posted(), _claimed(T0 + _hours(2)), _withdrawn(T0 + _hours(4), displaced=True)]
    index = _index(events)
    label, reason = index.label(LISTING, T0 + _hours(1))
    assert (label, reason) == (0, LabelOutcome.CLAIMED)


def test_release_then_expiry_is_wasted_after_the_release() -> None:
    """The case the per-listing rule gets backwards.

    `release_claim` puts a listing back on offer, so `open -> claimed -> open ->
    expired` is a real path. A per-listing label would see the `listing_claimed`
    event and mark **every** observation 0 — including the ones taken after the
    release, when the listing is open again and heading for expiry. Those are
    exactly the rows the model exists to flag.
    """
    events = [_posted(), _claimed(T0 + _hours(2)), _released(T0 + _hours(3))]
    index = _index(events)

    before_claim, _ = index.label(LISTING, T0 + _hours(1))
    after_release, reason = index.label(LISTING, T0 + _hours(4))

    assert before_claim == 0, "a claim was still ahead"
    assert (after_release, reason) == (1, LabelOutcome.WASTED)


def test_outcome_outside_the_corpus_is_right_censored() -> None:
    """A listing whose window closes after the log ends is neither claimed nor
    expired — it is unresolved, and labelling it either way records a guess as
    a fact."""
    index = _index([_posted(pickup_end_hours=40.0)], corpus_end_hours=20.0)
    label, reason = index.label(LISTING, T0 + _hours(1))
    assert label is None
    assert reason == LabelOutcome.CENSORED


# -- observation cadence -----------------------------------------------------


def test_observations_are_hourly_from_post_time_and_stop_at_pickup_end() -> None:
    log = sorted_log([_posted(pickup_end_hours=5.0)])
    observations = [o for o in build_observations(iter(log)) if o.listing_id == LISTING]

    assert observations[0].as_of == T0
    gaps = {
        round((b.as_of - a.as_of).total_seconds() / 3600.0, 6) for a, b in pairwise(observations)
    }
    assert gaps == {1.0}
    assert all(o.as_of < T0 + _hours(5.0) for o in observations)
    assert len(observations) == 5


def test_a_claimed_listing_stops_being_observed_and_resumes_on_release() -> None:
    log = sorted_log(
        [_posted(pickup_end_hours=8.0), _claimed(T0 + _hours(2)), _released(T0 + _hours(5))]
    )
    times = [o.as_of for o in build_observations(iter(log)) if o.listing_id == LISTING]

    assert T0 + _hours(1) in times, "observed while open"
    assert T0 + _hours(3) not in times, "still observed while claimed"
    assert T0 + _hours(4) not in times, "still observed while claimed"
    assert T0 + _hours(5) in times, "not resumed after the release"


def test_a_withdrawn_listing_stops_being_observed() -> None:
    log = sorted_log([_posted(pickup_end_hours=8.0), _withdrawn(T0 + _hours(3))])
    times = [o.as_of for o in build_observations(iter(log)) if o.listing_id == LISTING]
    assert max(times) < T0 + _hours(4)


# -- donor history -----------------------------------------------------------


def test_a_donor_with_no_history_has_null_rates_not_zero() -> None:
    """Encoding "no prior listings" as a 0.0 claim rate would tell the model
    this donor never gets claimed, which is the opposite of what is known."""
    log = sorted_log([_posted()])
    observation = next(o for o in build_observations(iter(log)) if o.listing_id == LISTING)

    assert observation.features["donor_prior_listings"] == 0
    assert observation.features["donor_prior_claim_rate"] is None
    assert observation.features["donor_prior_completion_rate"] is None
    assert observation.features["donor_hours_since_last_post"] is None
    assert observation.features["donor_median_claim_latency"] is None


def test_reference_agrees_with_the_pipeline_on_a_hand_built_log() -> None:
    log = sorted_log([_posted(pickup_end_hours=6.0), _claimed(T0 + _hours(3))])
    observation = next(o for o in build_observations(iter(log)) if o.listing_id == LISTING)
    expected = features_as_of(log, LISTING, observation.as_of)
    for name, value in expected.items():
        assert observation.features[name] == value, name


# -- text features -----------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12 trays", 12.0),
        ("1 case", 1.0),
        ("40.5 kg", 40.5),
        ("  7 boxes", 7.0),
        ("several boxes", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_quantity_units(text: str | None, expected: float | None) -> None:
    assert parse_quantity_units(text) == expected


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Day-old bread", "bakery"),
        ("Frozen vegetables", "frozen"),  # storage beats ingredient
        ("Mixed produce cases", "produce"),
        ("Milk and yoghurt", "dairy"),
        ("Bottled water", "beverages"),
        ("Hot meal trays", "prepared_meals"),
        ("Rice and pasta", "dry_goods"),
        ("Assorted sundries", "other"),
        (None, None),
    ],
)
def test_food_category(title: str | None, expected: str | None) -> None:
    assert food_category(title) == expected


def test_vectorised_and_scalar_haversine_agree() -> None:
    """The spatial index uses a numpy copy of `simulate.geo.haversine_km`. Two
    implementations of one formula is exactly how a subtle drift starts."""
    import numpy as np

    from ml.features.geo_index import _haversine_vector

    lats = np.array([41.90, 41.75, 42.05, 41.52])
    lngs = np.array([-87.62, -88.15, -87.69, -88.08])
    vector = _haversine_vector(41.88, -87.63, lats, lngs)
    scalar = [haversine_km(41.88, -87.63, la, ln) for la, ln in zip(lats, lngs, strict=True)]
    assert np.allclose(vector, scalar, rtol=1e-12, atol=1e-9)


def test_a_simulated_corpus_produces_observations_for_most_listings() -> None:
    """A smoke test at a realistic shape: if the cadence logic were badly wrong
    the ratio here would collapse to 1.0 or explode."""
    config = SimulationConfig(seed=404, months=1, n_donors=20, n_recipients=14)
    events, _ = simulate(config)
    log = sorted_log(from_events(events))
    observations = list(build_observations(iter(log)))
    listings = {o.listing_id for o in observations}

    assert len(listings) > 100
    assert 1.5 < len(observations) / len(listings) < 40.0
