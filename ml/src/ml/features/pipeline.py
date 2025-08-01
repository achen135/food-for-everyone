"""The streaming as-of feature pipeline.

One forward pass over the event log, with a heap of pending observations merged
into it. `reference.py` is the specification; this is the version that finishes.

## Why leakage is structurally impossible here, not merely avoided

The usual way to build point-in-time features is to write a query with an
`as_of` filter in it and hope every join respects it. That is the shape that
leaks: one `LEFT JOIN` without the predicate and a feature quietly sees the
future.

This pipeline cannot express that mistake. It walks the log forward, holding
accumulated state, and emits an observation from **whatever state currently
exists**. There is no filter to forget, because there is nothing to filter —
events after `as_of` have not been read yet. The leakage guard then verifies
the result against `reference.py`, so the fast path is checked against the
obvious one rather than trusted.

## The tie-break that matters

At an instant where an event and an observation coincide, **the event is
processed first**. `features_as_of` includes events with `occurred_at <= as_of`,
so an observation at exactly an event's timestamp must see it. Getting this
backwards produces a discrepancy in roughly one row in ten thousand — frequent
enough to be real, rare enough to look like noise.

## Observation cadence

At post time, then hourly for as long as the listing is open (§1: "scored at
post time and re-scored hourly"). A listing that is claimed stops being
observed; if it is released it becomes open again and resumes. Observations
stop at `pickup_end`.
"""

from __future__ import annotations

import heapq
import statistics
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ml.features.geo_index import NeighbourIndex
from ml.features.log import LogEvent
from ml.features.spec import (
    CLAIM_WINDOW_HOURS,
    MARKET_RADIUS_KM,
    NEAR_RADIUS_KM,
    OBSERVATION_INTERVAL_HOURS,
)
from ml.features.text import food_category, parse_quantity_units

__all__ = ["Observation", "PipelineStats", "build_observations"]


@dataclass(frozen=True, slots=True)
class Observation:
    """One row destined for `features_waste`, before labelling."""

    listing_id: str
    as_of: datetime
    features: dict[str, Any]


@dataclass(slots=True)
class PipelineStats:
    events_read: int = 0
    listings_seen: int = 0
    observations: int = 0
    donors: int = 0
    recipients: int = 0


@dataclass(slots=True)
class _DonorState:
    """Running totals for one donor. Snapshotted into a listing at post time."""

    index: int
    posts: int = 0
    claimed: int = 0
    completed: int = 0
    cancelled: int = 0
    last_post: datetime | None = None
    latencies: list[float] = field(default_factory=list)
    _median: float | None = None
    _median_valid: bool = False

    def median_latency(self) -> float | None:
        if not self._median_valid:
            self._median = float(statistics.median(self.latencies)) if self.latencies else None
            self._median_valid = True
        return self._median

    def record_latency(self, hours: float) -> None:
        self.latencies.append(hours)
        self._median_valid = False


@dataclass(slots=True)
class _ListingState:
    listing_id: str
    donor_id: str
    donor_index: int
    donor_lat: float
    donor_lng: float
    posted_at: datetime
    pickup_start: datetime
    pickup_end: datetime
    #: Everything about the donor and the listing that is fixed at post time.
    static: dict[str, Any]
    status: str = "open"
    counted_open: bool = False
    #: Whether this listing has already counted towards its donor's claim rate.
    #: A listing can be claimed, released and claimed again, and "what fraction
    #: of this donor's listings got claimed" counts listings, not claim events.
    ever_claimed: bool = False


def _hours(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 3600.0


def _rate(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


# Heap ordering at a shared instant: events, then observations. See the module
# docstring — an observation at exactly an event's timestamp must see it.
_KIND_EVENT = 0
_KIND_OBSERVE = 1
_KIND_CLOSE = 2


def build_observations(
    events: Iterable[LogEvent],
    stats: PipelineStats | None = None,
) -> Iterator[Observation]:
    """Walk the log forward, yielding one observation per open-listing tick."""
    stats = stats if stats is not None else PipelineStats()

    index = NeighbourIndex(NEAR_RADIUS_KM, MARKET_RADIUS_KM)
    donors: dict[str, _DonorState] = {}
    listings: dict[str, _ListingState] = {}

    # Pending observations, ordered by due time.
    pending: list[tuple[datetime, int, str]] = []
    # Claims inside the rolling 7-day window, oldest first.
    claim_window: list[tuple[datetime, int]] = []
    claim_head = 0

    def expire_claims(now: datetime) -> None:
        """Drop claims that have fallen out of the 7-day window."""
        nonlocal claim_head
        cutoff = now - timedelta(hours=CLAIM_WINDOW_HOURS)
        while claim_head < len(claim_window) and claim_window[claim_head][0] <= cutoff:
            index.bump_claims(claim_window[claim_head][1], -1)
            claim_head += 1

    def set_open(listing: _ListingState, is_open: bool) -> None:
        if is_open and not listing.counted_open:
            index.bump_open(listing.donor_index, 1)
            listing.counted_open = True
        elif not is_open and listing.counted_open:
            index.bump_open(listing.donor_index, -1)
            listing.counted_open = False

    def schedule(listing: _ListingState, when: datetime) -> None:
        if when < listing.pickup_end:
            heapq.heappush(pending, (when, _KIND_OBSERVE, listing.listing_id))

    def observe(listing: _ListingState, as_of: datetime) -> Observation:
        features = dict(listing.static)
        features.update(
            {
                "hours_to_pickup_end": _hours(listing.pickup_end, as_of),
                "hours_since_posted": _hours(as_of, listing.posted_at),
                "as_of_hour": as_of.hour,
                "as_of_dow": as_of.weekday(),
                # `- 1` excludes the listing being observed: it is open and near
                # itself, and counting it would make the feature "competitors
                # plus me", which is a different quantity that happens to look
                # right.
                "open_listings_within_15km": int(index.open_nearby[listing.donor_index]) - 1,
                "claims_within_15km_prior_7d": int(index.claims_nearby[listing.donor_index]),
                "recipients_within_5km": int(index.recipients_near[listing.donor_index]),
                "recipients_within_15km": int(index.recipients_market[listing.donor_index]),
            }
        )
        return Observation(listing_id=listing.listing_id, as_of=as_of, features=features)

    event_iter = iter(events)
    next_event: LogEvent | None = next(event_iter, None)

    while next_event is not None or pending:
        take_event = next_event is not None and (
            not pending or (next_event.occurred_at, _KIND_EVENT) <= (pending[0][0], pending[0][1])
        )

        if take_event:
            assert next_event is not None
            event = next_event
            now = event.occurred_at
            expire_claims(now)
            stats.events_read += 1

            if event.event_type == "listing_posted":
                payload = event.payload
                donor_id = payload["donor_org_id"]
                donor_lat = float(payload["donor_lat"])
                donor_lng = float(payload["donor_lng"])
                donor_index = index.add_donor(donor_id, donor_lat, donor_lng)
                donor = donors.get(donor_id)
                if donor is None:
                    donor = _DonorState(index=donor_index)
                    donors[donor_id] = donor

                pickup_start = event.instant("pickup_start")
                pickup_end = event.instant("pickup_end")
                assert pickup_start is not None and pickup_end is not None

                # Snapshot the donor's record BEFORE counting this listing.
                static = {
                    "lead_time_hours": _hours(pickup_start, now),
                    "pickup_window_hours": _hours(pickup_end, pickup_start),
                    "quantity_units": parse_quantity_units(payload.get("quantity")),
                    "notes_length": int(payload["notes_length"]),
                    "food_category": food_category(payload.get("title")),
                    "donor_verified": bool(payload["donor_verified"]),
                    "donor_lat": donor_lat,
                    "donor_lng": donor_lng,
                    "posted_hour": now.hour,
                    "posted_dow": now.weekday(),
                    "pickup_end_hour": pickup_end.hour,
                    "donor_prior_listings": donor.posts,
                    "donor_prior_claim_rate": _rate(donor.claimed, donor.posts),
                    "donor_prior_completion_rate": _rate(donor.completed, donor.posts),
                    "donor_prior_cancel_rate": _rate(donor.cancelled, donor.posts),
                    "donor_hours_since_last_post": (
                        None if donor.last_post is None else _hours(now, donor.last_post)
                    ),
                    "donor_median_claim_latency": donor.median_latency(),
                }

                listing = _ListingState(
                    listing_id=event.listing_id,
                    donor_id=donor_id,
                    donor_index=donor_index,
                    donor_lat=donor_lat,
                    donor_lng=donor_lng,
                    posted_at=now,
                    pickup_start=pickup_start,
                    pickup_end=pickup_end,
                    static=static,
                )
                listings[event.listing_id] = listing
                stats.listings_seen += 1

                donor.posts += 1
                donor.last_post = now

                set_open(listing, True)
                # Observed at post time, then hourly.
                heapq.heappush(pending, (now, _KIND_OBSERVE, listing.listing_id))
                # And closed at `pickup_end`, always. Expiry emits no event —
                # that is the whole reason the label has to be derived — so
                # without this the listing would stay counted as open forever
                # and `open_listings_within_15km` would climb without bound.
                # It did, before the leakage guard caught it.
                heapq.heappush(pending, (pickup_end, _KIND_CLOSE, listing.listing_id))

            elif event.event_type == "listing_claimed":
                target = listings.get(event.listing_id)
                payload = event.payload
                index.add_recipient(
                    payload["recipient_org_id"],
                    float(payload["recipient_lat"]),
                    float(payload["recipient_lng"]),
                )
                if target is not None:
                    target.status = "claimed"
                    set_open(target, False)
                    donor = donors[target.donor_id]
                    if not target.ever_claimed:
                        target.ever_claimed = True
                        donor.claimed += 1
                    donor.record_latency(_hours(now, target.posted_at))
                    index.bump_claims(target.donor_index, 1)
                    claim_window.append((now, target.donor_index))

            elif event.event_type == "claim_completed":
                target = listings.get(event.listing_id)
                if target is not None:
                    target.status = "completed"
                    set_open(target, False)
                    donors[target.donor_id].completed += 1

            elif event.event_type == "claim_cancelled":
                # Released: back on offer, and observed again from here.
                target = listings.get(event.listing_id)
                if target is not None and now < target.pickup_end:
                    target.status = "open"
                    set_open(target, True)
                    heapq.heappush(pending, (now, _KIND_OBSERVE, target.listing_id))

            elif event.event_type == "listing_cancelled":
                target = listings.get(event.listing_id)
                if target is not None:
                    target.status = "cancelled"
                    set_open(target, False)
                    donors[target.donor_id].cancelled += 1

            next_event = next(event_iter, None)
            continue

        # An observation or a close is due.
        as_of, kind, listing_id = heapq.heappop(pending)
        listing = listings[listing_id]
        expire_claims(as_of)

        if kind == _KIND_CLOSE:
            set_open(listing, False)
            continue

        if as_of >= listing.pickup_end:
            set_open(listing, False)
            continue
        if listing.status != "open":
            # Claimed, completed or withdrawn since this tick was scheduled.
            # A release will schedule a fresh one.
            continue

        yield observe(listing, as_of)
        stats.observations += 1
        schedule(listing, as_of + timedelta(hours=OBSERVATION_INTERVAL_HOURS))

    stats.donors = index.donor_count
    stats.recipients = index.recipient_count
