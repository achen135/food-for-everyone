"""The reference implementation of the as-of features — slow and obvious.

This module is the *specification*. `pipeline.py` is an optimisation of it, and
`ml/tests/test_leakage.py` asserts the two agree on a sample of rows. When they
disagree, this one is right.

## Why two implementations is the point, not duplication

Point-in-time correctness is the single easiest thing to get wrong in a feature
pipeline and the single hardest to notice: a leaked feature does not crash, it
just produces a model that scores beautifully offline and collapses in
production. The usual defences — code review, a careful comment — do not catch
it, because the leak is usually a join that quietly picks up a row it should not
have.

So the guard is structural. Here, every feature is written as a filter over a
list of events, with the filter `occurred_at <= as_of` applied *once, at the
top*. That makes the property visually checkable in a way the streaming version
never can be. The streaming version then has to match it.

The second assertion is the stronger one: handing `features_as_of` the **entire
log**, unfiltered, must produce identical values to handing it only the events
up to `as_of`. It can only do that if nothing inside ever looks past `as_of`.
That is a proof about the code, not a spot check about the data.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from ml.features.log import LogEvent
from ml.features.spec import CLAIM_WINDOW_HOURS, MARKET_RADIUS_KM, NEAR_RADIUS_KM
from ml.features.text import food_category, parse_quantity_units
from ml.simulate.geo import haversine_km

__all__ = ["LabelOutcome", "derive_label", "features_as_of", "listing_status_at"]


def _hours(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 3600.0


def _rate(numerator: int, denominator: int) -> float | None:
    """`None` rather than 0.0 for an empty denominator.

    A donor with no prior listings has no claim rate. Encoding that as zero
    would tell the model "this donor never gets claimed", which is the opposite
    of what is known, and it is exactly how a new-donor cold start turns into a
    systematically wrong prediction.
    """
    return None if denominator == 0 else numerator / denominator


def listing_status_at(events: Iterable[LogEvent], as_of: datetime) -> str:
    """Replay one listing's events to get its status at `as_of`.

    `open → claimed → open` is a real path: `release_claim` puts a listing back
    on offer. Anything that assumed a listing claimed once stays claimed would
    both miss later observations and mislabel them.
    """
    status = "absent"
    for event in events:
        if event.occurred_at > as_of:
            break
        if event.event_type == "listing_posted":
            status = "open"
        elif event.event_type == "listing_claimed":
            status = "claimed"
        elif event.event_type == "claim_completed":
            status = "completed"
        elif event.event_type == "claim_cancelled":
            status = "open"
        elif event.event_type == "listing_cancelled":
            status = "cancelled"
    return status


def features_as_of(
    events: list[LogEvent],
    listing_id: str,
    as_of: datetime,
) -> dict[str, Any]:
    """Every feature for one listing at one instant.

    `events` may be the whole log; the filter below is what makes that safe, and
    the leakage guard checks that it is.
    """
    # THE line. Everything after this sees only the past.
    prior = [event for event in events if event.occurred_at <= as_of]

    posted = next(
        (
            event
            for event in prior
            if event.listing_id == listing_id and event.event_type == "listing_posted"
        ),
        None,
    )
    if posted is None:
        raise ValueError(f"listing {listing_id} has no listing_posted at or before {as_of}")

    payload = posted.payload
    donor_id = payload["donor_org_id"]
    donor_lat = float(payload["donor_lat"])
    donor_lng = float(payload["donor_lng"])
    pickup_start = posted.instant("pickup_start")
    pickup_end = posted.instant("pickup_end")
    assert pickup_start is not None and pickup_end is not None

    # -- donor track record ------------------------------------------------
    #
    # **All donor-history features are evaluated as of this listing's POST
    # time**, not as of the observation. The rule in one sentence: *what was
    # this donor's record when the listing went up?*
    #
    # The alternative — re-evaluating the outcomes of the donor's earlier
    # listings at every hourly observation — is defensible too, and it is what a
    # first reading of "events with occurred_at <= as_of" suggests. It was
    # rejected for two reasons. It makes each listing's history a *moving*
    # aggregate over a frozen set of other listings, which is a genuinely
    # awkward thing to maintain incrementally and an easy place to introduce a
    # subtle off-by-one. And it buys almost nothing: prior listings resolve
    # within hours, so by the time a listing is being re-scored its donor's
    # earlier outcomes have almost all settled.
    #
    # Both versions satisfy the point-in-time rule — `posted.occurred_at` is
    # itself `<= as_of`. This one is simply the statable one.
    at_post = posted.occurred_at

    donor_posts = [
        event
        for event in prior
        if event.event_type == "listing_posted"
        and event.payload["donor_org_id"] == donor_id
        and event.occurred_at < at_post
    ]
    prior_ids = {event.listing_id for event in donor_posts}

    def _ids_of(event_type: str) -> set[str]:
        return {
            event.listing_id
            for event in prior
            if event.event_type == event_type
            and event.occurred_at <= at_post
            and event.listing_id in prior_ids
        }

    claimed_ids = _ids_of("listing_claimed")
    completed_ids = _ids_of("claim_completed")
    cancelled_ids = _ids_of("listing_cancelled")

    last_post = max((event.occurred_at for event in donor_posts), default=None)

    # Median post-to-claim latency over the donor's previously claimed listings.
    post_times = {event.listing_id: event.occurred_at for event in donor_posts}
    latencies: list[float] = []
    for event in prior:
        if (
            event.event_type == "listing_claimed"
            and event.occurred_at <= at_post
            and event.listing_id in post_times
        ):
            latencies.append(_hours(event.occurred_at, post_times[event.listing_id]))

    # -- local market ------------------------------------------------------
    # Recipient geography comes from prior `listing_claimed` payloads: the log
    # has no organization-registration event, so a recipient is only *known* to
    # the pipeline once it has claimed something. See ml/baselines/rules.py for
    # what that proxy costs.
    recipient_sites: dict[str, tuple[float, float]] = {}
    for event in prior:
        if event.event_type != "listing_claimed":
            continue
        recipient_id = event.payload["recipient_org_id"]
        if recipient_id not in recipient_sites:
            recipient_sites[recipient_id] = (
                float(event.payload["recipient_lat"]),
                float(event.payload["recipient_lng"]),
            )

    within_5 = 0
    within_15 = 0
    for lat, lng in recipient_sites.values():
        distance = haversine_km(donor_lat, donor_lng, lat, lng)
        if distance <= NEAR_RADIUS_KM:
            within_5 += 1
        if distance <= MARKET_RADIUS_KM:
            within_15 += 1

    # Competing supply: other listings open right now, near here.
    by_listing: dict[str, list[LogEvent]] = {}
    for event in prior:
        by_listing.setdefault(event.listing_id, []).append(event)

    open_nearby = 0
    for other_id, other_events in by_listing.items():
        if other_id == listing_id:
            continue
        other_posted = next((e for e in other_events if e.event_type == "listing_posted"), None)
        if other_posted is None:
            continue
        other_end = other_posted.instant("pickup_end")
        if other_end is None or other_end <= as_of:
            continue
        if listing_status_at(other_events, as_of) != "open":
            continue
        distance = haversine_km(
            donor_lat,
            donor_lng,
            float(other_posted.payload["donor_lat"]),
            float(other_posted.payload["donor_lng"]),
        )
        if distance <= MARKET_RADIUS_KM:
            open_nearby += 1

    # Recent demand: claims near here in the last seven days.
    window_start = as_of - timedelta(hours=CLAIM_WINDOW_HOURS)
    claims_nearby = 0
    for event in prior:
        if event.event_type != "listing_claimed" or event.occurred_at <= window_start:
            continue
        distance = haversine_km(
            donor_lat,
            donor_lng,
            float(event.payload["donor_lat"]),
            float(event.payload["donor_lng"]),
        )
        if distance <= MARKET_RADIUS_KM:
            claims_nearby += 1

    return {
        "hours_to_pickup_end": _hours(pickup_end, as_of),
        "hours_since_posted": _hours(as_of, posted.occurred_at),
        "lead_time_hours": _hours(pickup_start, posted.occurred_at),
        "pickup_window_hours": _hours(pickup_end, pickup_start),
        "quantity_units": parse_quantity_units(payload.get("quantity")),
        "notes_length": int(payload["notes_length"]),
        "food_category": food_category(payload.get("title")),
        "donor_verified": bool(payload["donor_verified"]),
        "donor_lat": donor_lat,
        "donor_lng": donor_lng,
        "posted_hour": posted.occurred_at.hour,
        "posted_dow": posted.occurred_at.weekday(),
        "as_of_hour": as_of.hour,
        "as_of_dow": as_of.weekday(),
        "pickup_end_hour": pickup_end.hour,
        "donor_prior_listings": len(donor_posts),
        "donor_prior_claim_rate": _rate(len(claimed_ids), len(donor_posts)),
        "donor_prior_completion_rate": _rate(len(completed_ids), len(donor_posts)),
        "donor_prior_cancel_rate": _rate(len(cancelled_ids), len(donor_posts)),
        "donor_hours_since_last_post": (
            None if last_post is None else _hours(posted.occurred_at, last_post)
        ),
        "donor_median_claim_latency": (
            None if not latencies else float(statistics.median(latencies))
        ),
        "recipients_within_5km": within_5,
        "recipients_within_15km": within_15,
        "open_listings_within_15km": open_nearby,
        "claims_within_15km_prior_7d": claims_nearby,
    }


class LabelOutcome:
    """Why an observation got the label it got — or why it has none."""

    WASTED = "wasted"
    CLAIMED = "claimed"
    WITHDRAWN = "withdrawn"
    CENSORED = "censored"


def derive_label(
    listing_events: list[LogEvent],
    as_of: datetime,
    corpus_end: datetime,
) -> tuple[int | None, str]:
    """The label for one open-listing observation, and the reason for it.

    Returns `(None, reason)` for an observation that must be dropped.

    ## The definition, and where it refines the brief

    The brief states the label as: `listing_posted` ∧ `pickup_end < as_of` ∧ no
    `listing_claimed` for that listing ∧ not `listing_cancelled` while
    unclaimed. That is a statement about a *listing*, evaluated after its window
    closed, and for the overwhelmingly common case — a listing that is never
    claimed at all — this function agrees with it exactly.

    It differs on one case, deliberately. `release_claim` puts a claimed listing
    **back on offer**, so a listing can go `open → claimed → open → expired`.
    Under a per-listing rule that listing has a `listing_claimed` event, so
    every observation of it is labelled 0 — including the observations taken
    *after* the release, when the listing is open again and heading for
    expiry. Those are precisely the observations the model exists to flag, and
    the per-listing rule labels them backwards.

    So the label is per-observation and forward-looking, which is also what the
    model is actually asked at serving time — *this listing is open now; will it
    expire unclaimed?*:

        1  no claim after `as_of`, not withdrawn-while-unclaimed after `as_of`,
           and `pickup_end` is inside the corpus
        0  some claim happens after `as_of`
        -  withdrawn while unclaimed: dropped, not labelled
        -  `pickup_end` past the end of the corpus: right-censored, dropped

    **Withdrawn is not wasted.** A donor who pulls an unclaimed offer — sold it,
    posted it twice — did not waste food, and counting them as positives would
    bake false positives into the training labels with nothing in the log to say
    otherwise. This is the entire reason M10 emitted a fifth event type that its
    own brief did not ask for; the payoff is this branch.
    """
    posted = next((e for e in listing_events if e.event_type == "listing_posted"), None)
    if posted is None:
        raise ValueError("listing has no listing_posted event")
    pickup_end = posted.instant("pickup_end")
    assert pickup_end is not None

    future = [event for event in listing_events if event.occurred_at > as_of]

    if any(event.event_type == "listing_claimed" for event in future):
        return 0, LabelOutcome.CLAIMED

    withdrawn_unclaimed = any(
        event.event_type == "listing_cancelled" and event.payload.get("displaced_claim_id") is None
        for event in future
    )
    if withdrawn_unclaimed:
        return None, LabelOutcome.WITHDRAWN

    if pickup_end > corpus_end:
        return None, LabelOutcome.CENSORED

    return 1, LabelOutcome.WASTED
