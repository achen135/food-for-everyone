"""The as-of feature state, and the streaming pipeline built on it.

`reference.py` is the specification; this is the version that finishes.

## Why leakage is structurally impossible here, not merely avoided

The usual way to build point-in-time features is to write a query with an
`as_of` filter in it and hope every join respects it. That is the shape that
leaks: one `LEFT JOIN` without the predicate and a feature quietly sees the
future.

`FeatureState` cannot express that mistake. Events are pushed into it one at a
time in chronological order, and a snapshot is taken from **whatever state
currently exists**. There is no filter to forget, because there is nothing to
filter — events after `as_of` have not been applied yet. The leakage guard then
verifies the result against `reference.py`, so the fast path is checked against
the obvious one rather than trusted.

## One state object, two callers

`build_observations` walks the corpus and emits a row per open-listing tick;
`ml.serve` replays a log up to a request's `as_of` and takes a single snapshot.
Both go through `FeatureState`, which is the point — "features via the same
functions as the pipeline" is only true if there is one implementation, and
training/serving skew starts with two code paths that each compute "the
features" slightly differently.

## Advancing time without an event

`snapshot` takes an `as_of` that may be **later than the last applied event**,
and the features have to reflect that. `hours_to_pickup_end` shrinks with the
clock; `claims_within_15km_prior_7d` drops claims that have aged out of the
window; `open_listings_within_15km` stops counting listings whose pickup window
has closed — and expiry emits no event, so nothing in the log would ever say so.
`advance_to` is what makes those decay, and it is called by `apply` and
`snapshot` alike.

## The tie-break that matters

At an instant where an event and an observation coincide, **the event is
processed first**. `features_as_of` includes events with `occurred_at <= as_of`,
so an observation at exactly an event's timestamp must see it. Getting this
backwards produces a discrepancy in roughly one row in ten thousand — frequent
enough to be real, rare enough to look like noise.

A listing closes at `pickup_end` **strictly before** an observation at that same
instant counts it as shut. That is not an arbitrary choice: it is what the
original single-heap ordering did, where a close sorted after an observation at
a tied timestamp, and the leakage guard is sensitive to it.

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

__all__ = ["FeatureState", "Observation", "PipelineStats", "build_observations"]


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


class StaleSnapshotError(RuntimeError):
    """A snapshot was asked for at an instant already overtaken by the log."""


class FeatureState:
    """Accumulated as-of state for every donor, listing and neighbourhood.

    Fed events in chronological order through `apply`; queried through
    `snapshot`. Holds no reference to anything that knows the future — the label
    is derived in a separate pass over the log (`ml/src/ml/features/labels.py`),
    and keeping the two apart is what makes leakage structural rather than a
    matter of discipline.
    """

    __slots__ = (
        "_claim_head",
        "_claim_window",
        "_closes",
        "_donors",
        "_index",
        "_last_event_at",
        "_listings",
        "_stats",
    )

    def __init__(self, stats: PipelineStats | None = None) -> None:
        self._index = NeighbourIndex(NEAR_RADIUS_KM, MARKET_RADIUS_KM)
        self._donors: dict[str, _DonorState] = {}
        self._listings: dict[str, _ListingState] = {}
        #: Claims inside the rolling 7-day window, oldest first. A head index
        #: rather than a deque pop: the list is never rewritten, so an entry's
        #: position is stable and the window is a slice of it.
        self._claim_window: list[tuple[datetime, int]] = []
        self._claim_head = 0
        #: Listings due to stop counting as open, by `pickup_end`. Expiry emits
        #: no event — that is the whole reason the label has to be derived — so
        #: without this a listing would stay counted as open forever and
        #: `open_listings_within_15km` would climb without bound. It did, before
        #: the leakage guard caught it.
        self._closes: list[tuple[datetime, str]] = []
        self._last_event_at: datetime | None = None
        self._stats = stats if stats is not None else PipelineStats()

    # -- reading ------------------------------------------------------------

    @property
    def stats(self) -> PipelineStats:
        self._stats.donors = self._index.donor_count
        self._stats.recipients = self._index.recipient_count
        return self._stats

    def listing(self, listing_id: str) -> _ListingState | None:
        return self._listings.get(listing_id)

    def is_open(self, listing_id: str, as_of: datetime) -> bool:
        """Is this listing on offer at `as_of` — the population the model saw?

        Training rows are emitted only while a listing is open and only before
        `pickup_end`, so anything else is out of distribution. Both the endpoint
        and M14's batch scorer need this question answered the same way.
        """
        listing = self._listings.get(listing_id)
        return listing is not None and listing.status == "open" and as_of < listing.pickup_end

    def open_listings(self, as_of: datetime) -> list[str]:
        """Every listing on offer at `as_of`. M14's batch scorer works from this."""
        self.advance_to(as_of)
        return [
            listing_id
            for listing_id, listing in self._listings.items()
            if listing.status == "open" and as_of < listing.pickup_end
        ]

    def __contains__(self, listing_id: str) -> bool:
        return listing_id in self._listings

    # -- advancing ----------------------------------------------------------

    def advance_to(self, as_of: datetime) -> None:
        """Move the clock to `as_of` without applying any new event.

        Two things decay purely with time. Claims fall out of the trailing
        7-day window, and listings stop being open once their pickup window
        shuts. Both are idempotent and monotone, so calling this repeatedly with
        non-decreasing instants gives the same state as calling it once with the
        last of them.
        """
        cutoff = as_of - timedelta(hours=CLAIM_WINDOW_HOURS)
        while self._claim_head < len(self._claim_window):
            when, donor_index = self._claim_window[self._claim_head]
            if when > cutoff:
                break
            self._index.bump_claims(donor_index, -1)
            self._claim_head += 1

        # Strictly before `as_of`: a listing whose window closes at exactly this
        # instant is still counted by an observation taken at it. See the module
        # docstring on the tie-break.
        while self._closes and self._closes[0][0] < as_of:
            _, listing_id = heapq.heappop(self._closes)
            listing = self._listings.get(listing_id)
            if listing is not None:
                self._set_open(listing, False)

    def _set_open(self, listing: _ListingState, is_open: bool) -> None:
        if is_open and not listing.counted_open:
            self._index.bump_open(listing.donor_index, 1)
            listing.counted_open = True
        elif not is_open and listing.counted_open:
            self._index.bump_open(listing.donor_index, -1)
            listing.counted_open = False

    # -- applying -----------------------------------------------------------

    def apply(self, event: LogEvent) -> str | None:
        """Fold one event in. Returns a listing to observe now, if any.

        The return value is the only thing the driver needs in order to keep the
        observation cadence: a listing is observed the instant it is posted, and
        again the instant it is released back onto the market.
        """
        now = event.occurred_at
        self.advance_to(now)
        self._last_event_at = now
        self._stats.events_read += 1

        if event.event_type == "listing_posted":
            return self._posted(event, now)
        if event.event_type == "listing_claimed":
            self._claimed(event, now)
        elif event.event_type == "claim_completed":
            self._completed(event)
        elif event.event_type == "claim_cancelled":
            return self._released(event, now)
        elif event.event_type == "listing_cancelled":
            self._withdrawn(event)
        return None

    def _posted(self, event: LogEvent, now: datetime) -> str:
        payload = event.payload
        donor_id = payload["donor_org_id"]
        donor_lat = float(payload["donor_lat"])
        donor_lng = float(payload["donor_lng"])
        donor_index = self._index.add_donor(donor_id, donor_lat, donor_lng)
        donor = self._donors.get(donor_id)
        if donor is None:
            donor = _DonorState(index=donor_index)
            self._donors[donor_id] = donor

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
        self._listings[event.listing_id] = listing
        self._stats.listings_seen += 1

        donor.posts += 1
        donor.last_post = now

        self._set_open(listing, True)
        heapq.heappush(self._closes, (pickup_end, listing.listing_id))
        return listing.listing_id

    def _claimed(self, event: LogEvent, now: datetime) -> None:
        payload = event.payload
        self._index.add_recipient(
            payload["recipient_org_id"],
            float(payload["recipient_lat"]),
            float(payload["recipient_lng"]),
        )
        target = self._listings.get(event.listing_id)
        if target is None:
            return
        target.status = "claimed"
        self._set_open(target, False)
        donor = self._donors[target.donor_id]
        if not target.ever_claimed:
            target.ever_claimed = True
            donor.claimed += 1
        donor.record_latency(_hours(now, target.posted_at))
        self._index.bump_claims(target.donor_index, 1)
        self._claim_window.append((now, target.donor_index))

    def _completed(self, event: LogEvent) -> None:
        target = self._listings.get(event.listing_id)
        if target is not None:
            target.status = "completed"
            self._set_open(target, False)
            self._donors[target.donor_id].completed += 1

    def _released(self, event: LogEvent, now: datetime) -> str | None:
        """Released: back on offer, and observed again from here."""
        target = self._listings.get(event.listing_id)
        if target is None or now >= target.pickup_end:
            return None
        target.status = "open"
        self._set_open(target, True)
        return target.listing_id

    def _withdrawn(self, event: LogEvent) -> None:
        target = self._listings.get(event.listing_id)
        if target is not None:
            target.status = "cancelled"
            self._set_open(target, False)
            self._donors[target.donor_id].cancelled += 1

    # -- snapshotting -------------------------------------------------------

    def snapshot(self, listing_id: str, as_of: datetime) -> dict[str, Any]:
        """Every feature for one listing at one instant.

        Raises if `as_of` precedes the last applied event: the state has already
        seen further than the caller is asking about, so the answer would
        include the future. In the batch pipeline that cannot happen — the merge
        only applies an event when it is due — but the serving path builds its
        state from a query and this is the boundary where a wrong `as_of` would
        otherwise pass silently.
        """
        if self._last_event_at is not None and as_of < self._last_event_at:
            raise StaleSnapshotError(
                f"as_of {as_of.isoformat()} precedes the last applied event "
                f"{self._last_event_at.isoformat()}; the state has seen past it"
            )
        listing = self._listings.get(listing_id)
        if listing is None:
            raise KeyError(listing_id)
        self.advance_to(as_of)
        return self._observe(listing, as_of)

    def _observe(self, listing: _ListingState, as_of: datetime) -> dict[str, Any]:
        index = self._index
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
        return features


def build_observations(
    events: Iterable[LogEvent],
    stats: PipelineStats | None = None,
) -> Iterator[Observation]:
    """Walk the log forward, yielding one observation per open-listing tick.

    A thin driver over `FeatureState`: it owns the observation cadence and the
    merge between due observations and incoming events, and nothing else. Every
    feature value comes out of `FeatureState.snapshot`, which is the same call
    the serving path makes.
    """
    state = FeatureState(stats)
    pending: list[tuple[datetime, str]] = []

    event_iter = iter(events)
    next_event: LogEvent | None = next(event_iter, None)

    while next_event is not None or pending:
        # `<=` is the tie-break: at a shared instant the event goes first, so an
        # observation at exactly an event's timestamp sees it.
        take_event = next_event is not None and (
            not pending or next_event.occurred_at <= pending[0][0]
        )

        if take_event:
            assert next_event is not None
            observe_now = state.apply(next_event)
            if observe_now is not None:
                heapq.heappush(pending, (next_event.occurred_at, observe_now))
            next_event = next(event_iter, None)
            continue

        as_of, listing_id = heapq.heappop(pending)
        listing = state.listing(listing_id)
        assert listing is not None

        if as_of >= listing.pickup_end:
            state.advance_to(as_of)
            continue
        if listing.status != "open":
            # Claimed, completed or withdrawn since this tick was scheduled.
            # A release will schedule a fresh one.
            state.advance_to(as_of)
            continue

        features = state.snapshot(listing_id, as_of)
        yield Observation(listing_id=listing_id, as_of=as_of, features=features)
        state.stats.observations += 1

        following = as_of + timedelta(hours=OBSERVATION_INTERVAL_HOURS)
        if following < listing.pickup_end:
            heapq.heappush(pending, (following, listing_id))

    # Refresh the derived counts one last time for a caller holding `stats`.
    _ = state.stats
