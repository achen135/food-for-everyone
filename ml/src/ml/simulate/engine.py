"""The behavioural model: a discrete-event simulation over simulated time.

## Shape of the thing

One heap, ordered by `(instant, sequence)`, processed forward. A listing's life
is a chain of scheduled transitions rather than a per-day sweep, which matters
for two reasons: events come out already sorted by `occurred_at`, the same
order the production log accumulates in; and a listing's fate depends on the
state of the world *at the moment it is posted*, not on a daily aggregate.

    POST ──▶ emit listing_posted
             ├─ schedule CLAIM   (time drawn from a hazard, may exceed the window)
             ├─ schedule WITHDRAW (with probability donor.withdraw_rate)
             └─ schedule CLOSE   (at pickup_end — bookkeeping, emits nothing)

    CLAIM ──▶ emit listing_claimed ──▶ schedule OUTCOME
                                        ├─ COMPLETE ▶ emit claim_completed
                                        └─ RELEASE  ▶ emit claim_cancelled
                                                      └─ reopen, reschedule CLAIM

    WITHDRAW ▶ emit listing_cancelled  (displaced_* populated iff it was claimed)

    CLOSE ──▶ nothing. A listing still open at `pickup_end` is wasted food, and
              **that is a non-event** — the whole reason M12 has to derive the
              label instead of reading it. FFE emits events only for
              transitions someone performs (`docs/ML Subsystem.md` §2, "Expiry
              is derived on the ML side too"), and this simulator holds to that
              exactly, including the inconvenience.

## The tie-break, and why determinism survives it

Two transitions can land on the same microsecond. The heap key carries a global
sequence number assigned at push time, so ties resolve by insertion order,
which is itself a deterministic function of the seed. Without it, `heapq` would
fall through to comparing the next tuple element and the ordering would depend
on UUID bytes — still deterministic, but for a reason nobody could later
reconstruct.

## Two approximations, both deliberate

**Competition is counted per cluster, not per radius.** The honest computation
of "open listings within 15 km of this donor, right now" is a spatial query
against live state on every post: ~110k posts x hundreds of open listings is
tens of millions of distance calculations, and it would dominate the runtime of
`make data`. Instead each cluster keeps a counter of its open listings and
competition is read off the donor's cluster plus every cluster whose centre is
within 15 km. It is a coarser number with the same behaviour — dense areas
crowd, sparse ones do not.

**Recipients act only during opening hours.** A claim time that lands at 03:00
is pushed to 07:00 rather than redrawn, which slightly thickens the morning
edge. Redrawing would bias toward short latencies; pushing preserves the
ordering of who was going to act first.
"""

from __future__ import annotations

import heapq
import math
import random
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from ml.events import Event, format_instant
from ml.simulate.config import (
    CATEGORY_DESIRABILITY,
    CATEGORY_TITLES,
    POST_HOUR_WEIGHT,
    RECIPIENT_ACTIVE_HOURS,
    WEEKDAY_WEIGHT,
    SimulationConfig,
)
from ml.simulate.geo import CLUSTERS, haversine_km
from ml.simulate.orgs import Donor, Recipient, build_population
from ml.simulate.rng import new_uuid, substream

__all__ = ["Simulation", "SimulationStats", "simulate"]

#: Kinds of scheduled transition. Ordered so that, at an identical instant,
#: bookkeeping never runs before the transition it accounts for.
_POST = 0
_CLAIM = 1
_OUTCOME = 2
_WITHDRAW = 3
_CLOSE = 4

#: Radius within which one cluster counts as competition for another.
_COMPETITION_RADIUS_KM = 15.0

#: A listing that is released and re-listed repeatedly would loop forever if a
#: bug made the hazard unbounded. Real listings do get re-claimed; five rounds
#: is far past anything the rates produce and turns a hang into a bounded run.
_MAX_CLAIM_ROUNDS = 5

#: Units per food category, for the `quantity` text. Production stores quantity
#: as free text, so the simulator does too — and M12's feature has to parse it,
#: exactly as it would have to on real data.
_CATEGORY_UNITS: dict[str, tuple[str, float]] = {
    "prepared_meals": ("trays", 14.0),
    "produce": ("cases", 11.0),
    "bakery": ("trays", 9.0),
    "dairy": ("crates", 8.0),
    "dry_goods": ("boxes", 16.0),
    "frozen": ("cases", 7.0),
    "beverages": ("cases", 13.0),
}


@dataclass(slots=True)
class SimulationStats:
    """Counts, filled in as the run proceeds. Reported by the CLI."""

    donors: int = 0
    recipients: int = 0
    listings_posted: int = 0
    listings_claimed: int = 0
    claims_completed: int = 0
    claims_cancelled: int = 0
    listings_cancelled: int = 0
    #: Open at `pickup_end`, never claimed, never withdrawn — the positive
    #: class. Counted here only so the CLI can report the base rate; the
    #: pipeline derives it independently from the events.
    wasted: int = 0
    #: Still open when the simulated window ended, so the outcome is unknown.
    #: M12 drops these as right-censored.
    censored: int = 0

    @property
    def events(self) -> int:
        return (
            self.listings_posted
            + self.listings_claimed
            + self.claims_completed
            + self.claims_cancelled
            + self.listings_cancelled
        )


@dataclass(slots=True)
class _Listing:
    id: UUID
    donor: Donor
    donor_index: int
    posted_at: datetime
    pickup_start: datetime
    pickup_end: datetime
    category: str
    title: str
    quantity_text: str
    quantity_units: float
    notes_length: int

    status: str = "open"
    rounds: int = 0
    claim_id: UUID | None = None
    recipient: Recipient | None = None
    claimed_at: datetime | None = None
    withdraw_at: datetime | None = None
    counted_open: bool = False


def _poisson(rng: random.Random, lam: float) -> int:
    """Knuth's method. Adequate for the small means the donor rates produce."""
    if lam <= 0.0:
        return 0
    limit = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= limit:
            return k - 1


def _weighted_index(rng: random.Random, weights: tuple[float, ...]) -> int:
    total = 0.0
    for w in weights:
        total += w
    target = rng.random() * total
    upto = 0.0
    for index, w in enumerate(weights):
        upto += w
        if target < upto:
            return index
    return len(weights) - 1


def _shift_into_active_hours(when: datetime) -> datetime:
    """Move an instant forward to the next hour a recipient is working."""
    open_hour, close_hour = RECIPIENT_ACTIVE_HOURS
    if open_hour <= when.hour < close_hour:
        return when
    if when.hour < open_hour:
        return when.replace(hour=open_hour)
    return (when + timedelta(days=1)).replace(hour=open_hour)


class Simulation:
    """One run. Construct, then iterate `run()`.

    Not reusable: `run()` drains the heap. Build a new `Simulation` for a second
    pass — which is what the determinism test does, in a separate process.
    """

    def __init__(self, config: SimulationConfig) -> None:
        self.config = config
        self.population = build_population(config)
        self.stats = SimulationStats(
            donors=len(self.population.donors),
            recipients=len(self.population.recipients),
        )

        # One substream per decision class. Adding a draw to, say, outcomes
        # cannot then shift the post schedule (see `ml.simulate.rng`).
        self._rng_schedule = substream(config.seed, "engine/schedule")
        self._rng_listing = substream(config.seed, "engine/listing")
        self._rng_claim = substream(config.seed, "engine/claim")
        self._rng_outcome = substream(config.seed, "engine/outcome")
        self._rng_ids = substream(config.seed, "engine/ids")

        self._heap: list[tuple[datetime, int, int, UUID]] = []
        self._seq = 0
        self._listings: dict[UUID, _Listing] = {}
        self._open_by_cluster: dict[str, int] = {c.name: 0 for c in CLUSTERS}
        self._recipient_load: dict[UUID, int] = {r.id: 0 for r in self.population.recipients}

        self._candidates = self._build_candidates()
        self._cluster_neighbours = self._build_cluster_neighbours()

    # -- setup ------------------------------------------------------------

    def _build_candidates(self) -> list[tuple[tuple[int, float], ...]]:
        """Per donor, the recipients whose own radius reaches it.

        Note the direction: the filter is `distance <= recipient.radius_km`,
        the recipient's willingness to travel, not some global constant. A
        donor in a thin part of the map can genuinely have zero candidates,
        which is the condition M12's second baseline tests for.
        """
        limit = self.config.candidate_limit
        out: list[tuple[tuple[int, float], ...]] = []
        for donor in self.population.donors:
            near: list[tuple[int, float]] = []
            for index, recipient in enumerate(self.population.recipients):
                distance = haversine_km(donor.lat, donor.lng, recipient.lat, recipient.lng)
                if distance <= recipient.radius_km:
                    near.append((index, distance))
            # Sorted by distance, then index: a stable total order even when two
            # recipients sit at an identical distance.
            near.sort(key=lambda pair: (pair[1], pair[0]))
            out.append(tuple(near[:limit]))
        return out

    def _build_cluster_neighbours(self) -> dict[str, tuple[str, ...]]:
        neighbours: dict[str, tuple[str, ...]] = {}
        for a in CLUSTERS:
            names = [
                b.name
                for b in CLUSTERS
                if haversine_km(a.lat, a.lng, b.lat, b.lng) <= _COMPETITION_RADIUS_KM
            ]
            neighbours[a.name] = tuple(names)
        return neighbours

    # -- heap -------------------------------------------------------------

    def _schedule(self, when: datetime, kind: int, listing_id: UUID) -> None:
        self._seq += 1
        heapq.heappush(self._heap, (when, self._seq, kind, listing_id))

    # -- generation -------------------------------------------------------

    def _plan_posts(self) -> None:
        """Draw every listing's post time up front and seed the heap.

        Done in one pass over (day, donor) in fixed order so the schedule is a
        pure function of the seed, independent of anything that happens during
        the run.
        """
        config = self.config
        rng = self._rng_schedule
        for day in range(config.days):
            day_start = config.start + timedelta(days=day)
            weekday = (day_start.weekday() + 1) % 7  # Sunday-first, as WEEKDAY_WEIGHT
            weight = WEEKDAY_WEIGHT[weekday]
            for donor_index, donor in enumerate(self.population.donors):
                count = _poisson(rng, donor.rate * weight)
                for _ in range(count):
                    hour = _weighted_index(rng, POST_HOUR_WEIGHT)
                    posted_at = day_start + timedelta(
                        hours=hour,
                        minutes=rng.randrange(60),
                        seconds=rng.randrange(60),
                    )
                    listing = self._make_listing(donor, donor_index, posted_at)
                    self._listings[listing.id] = listing
                    self._schedule(posted_at, _POST, listing.id)

    def _make_listing(self, donor: Donor, donor_index: int, posted_at: datetime) -> _Listing:
        config = self.config
        rng = self._rng_listing

        category = donor.categories[rng.randrange(len(donor.categories))]
        titles = CATEGORY_TITLES[category]
        title = titles[rng.randrange(len(titles))]

        lead_hours = min(96.0, rng.lognormvariate(config.lead_time_mu, config.lead_time_sigma))
        window_hours = min(
            config.window_max_hours,
            max(
                config.window_min_hours,
                rng.lognormvariate(config.window_mu, config.window_sigma),
            ),
        )
        pickup_start = posted_at + timedelta(hours=lead_hours)
        pickup_end = pickup_start + timedelta(hours=window_hours)

        unit_word, unit_scale = _CATEGORY_UNITS[category]
        units = max(
            1.0,
            round(unit_scale * donor.capacity_scale * rng.lognormvariate(0.0, 0.45)),
        )
        quantity_text = f"{int(units)} {unit_word}"

        notes_length = max(
            0,
            int(rng.expovariate(1.0 / max(1.0, config.notes_length_mean * donor.notes_verbosity))),
        )

        return _Listing(
            id=new_uuid(self._rng_ids),
            donor=donor,
            donor_index=donor_index,
            posted_at=posted_at,
            pickup_start=pickup_start,
            pickup_end=pickup_end,
            category=category,
            title=title,
            quantity_text=quantity_text,
            quantity_units=units,
            notes_length=notes_length,
        )

    # -- hazard -----------------------------------------------------------

    def _competition(self, donor: Donor) -> int:
        total = 0
        for name in self._cluster_neighbours[donor.cluster.name]:
            total += self._open_by_cluster[name]
        return total

    def _claim_hazard(self, listing: _Listing) -> float:
        """Claims per hour for this listing, right now.

        The sum over candidate recipients is what makes geography bite: a donor
        with two distant candidates has a hazard an order of magnitude below one
        with thirty close ones, so its listings sit until the window closes.
        """
        config = self.config
        candidates = self._candidates[listing.donor_index]
        if not candidates:
            return 0.0

        reach = 0.0
        for index, distance in candidates:
            recipient = self.population.recipients[index]
            if listing.category not in recipient.categories:
                continue
            if self._recipient_load[recipient.id] >= recipient.capacity:
                continue
            reach += recipient.responsiveness * math.exp(-distance / config.distance_decay_km)

        if reach <= 0.0:
            return 0.0

        hazard = config.claim_hazard_base * reach
        hazard *= listing.donor.appeal
        hazard *= CATEGORY_DESIRABILITY[listing.category]
        if listing.donor.verified:
            hazard *= config.verified_hazard_bonus
        hazard /= 1.0 + config.competition_penalty * self._competition(listing.donor)
        hazard /= 1.0 + config.quantity_penalty * math.log1p(listing.quantity_units)
        return hazard

    def _schedule_claim_attempt(self, listing: _Listing, now: datetime) -> None:
        """Draw a time-to-claim; schedule it only if it lands inside the window.

        A draw past `pickup_end` is the wasted case, and it is represented by
        scheduling *nothing* — there is no event for food that was never taken.
        """
        hazard = self._claim_hazard(listing)
        if hazard <= 0.0:
            return
        wait_hours = self._rng_claim.expovariate(hazard)
        when = _shift_into_active_hours(now + timedelta(hours=wait_hours))
        if when >= listing.pickup_end:
            return
        self._schedule(when, _CLAIM, listing.id)

    def _pick_claimant(self, listing: _Listing) -> tuple[Recipient, float] | None:
        """Choose who claims, weighted the same way the hazard was summed."""
        candidates = self._candidates[listing.donor_index]
        weighted: list[tuple[int, float, float]] = []
        total = 0.0
        for index, distance in candidates:
            recipient = self.population.recipients[index]
            if listing.category not in recipient.categories:
                continue
            if self._recipient_load[recipient.id] >= recipient.capacity:
                continue
            weight = recipient.responsiveness * math.exp(-distance / self.config.distance_decay_km)
            weighted.append((index, distance, weight))
            total += weight

        if not weighted or total <= 0.0:
            return None

        target = self._rng_claim.random() * total
        upto = 0.0
        for index, distance, weight in weighted:
            upto += weight
            if target < upto:
                return self.population.recipients[index], distance
        index, distance, _ = weighted[-1]
        return self.population.recipients[index], distance

    # -- open-listing bookkeeping ----------------------------------------

    def _mark_open(self, listing: _Listing) -> None:
        if not listing.counted_open:
            self._open_by_cluster[listing.donor.cluster.name] += 1
            listing.counted_open = True

    def _mark_not_open(self, listing: _Listing) -> None:
        if listing.counted_open:
            self._open_by_cluster[listing.donor.cluster.name] -= 1
            listing.counted_open = False

    # -- the run ----------------------------------------------------------

    def run(self) -> Iterator[Event]:
        """Yield every event, in `occurred_at` order."""
        self._plan_posts()
        end = self.config.end

        while self._heap:
            when, _seq, kind, listing_id = heapq.heappop(self._heap)
            if when >= end:
                # Past the simulated window. Anything still open at this point
                # is right-censored; `_CLOSE` is what records that.
                if kind == _CLOSE:
                    listing = self._listings[listing_id]
                    if listing.status == "open":
                        self.stats.censored += 1
                        self._mark_not_open(listing)
                continue

            listing = self._listings[listing_id]

            if kind == _POST:
                yield from self._on_post(listing, when)
            elif kind == _CLAIM:
                yield from self._on_claim(listing, when)
            elif kind == _OUTCOME:
                yield from self._on_outcome(listing, when)
            elif kind == _WITHDRAW:
                yield from self._on_withdraw(listing, when)
            elif kind == _CLOSE:
                self._on_close(listing)

    def _on_post(self, listing: _Listing, when: datetime) -> Iterator[Event]:
        self.stats.listings_posted += 1
        self._mark_open(listing)

        yield Event(
            occurred_at=when,
            event_type="listing_posted",
            listing_id=listing.id,
            claim_id=None,
            actor_org_id=listing.donor.id,
            payload={
                "donor_org_id": str(listing.donor.id),
                "donor_lat": listing.donor.lat,
                "donor_lng": listing.donor.lng,
                "donor_verified": listing.donor.verified,
                "title": listing.title,
                "quantity": listing.quantity_text,
                "notes_length": listing.notes_length,
                "pickup_start": format_instant(listing.pickup_start),
                "pickup_end": format_instant(listing.pickup_end),
            },
        )

        # A withdrawal is drawn now but fires later, so it can land before or
        # after a claim — which is precisely what produces both the null and
        # the populated `displaced_*` cases the contract allows for.
        if self._rng_outcome.random() < listing.donor.withdraw_rate:
            span = (listing.pickup_end - when).total_seconds()
            offset = self._rng_outcome.random() * span
            listing.withdraw_at = when + timedelta(seconds=offset)
            self._schedule(listing.withdraw_at, _WITHDRAW, listing.id)

        self._schedule_claim_attempt(listing, when)
        self._schedule(listing.pickup_end, _CLOSE, listing.id)

    def _on_claim(self, listing: _Listing, when: datetime) -> Iterator[Event]:
        if listing.status != "open" or when >= listing.pickup_end:
            return

        picked = self._pick_claimant(listing)
        if picked is None:
            # Everyone in reach is at capacity. Try again later rather than
            # writing the listing off: capacity frees up as other pickups
            # complete, and this coupling is the only thing in the model that
            # makes one listing's fate depend on another's.
            listing.rounds += 1
            if listing.rounds <= _MAX_CLAIM_ROUNDS:
                self._schedule_claim_attempt(listing, when + timedelta(hours=1))
            return

        recipient, distance = picked

        listing.status = "claimed"
        listing.claim_id = new_uuid(self._rng_ids)
        listing.recipient = recipient
        listing.claimed_at = when
        self._recipient_load[recipient.id] += 1
        self._mark_not_open(listing)
        self.stats.listings_claimed += 1

        yield Event(
            occurred_at=when,
            event_type="listing_claimed",
            listing_id=listing.id,
            claim_id=listing.claim_id,
            actor_org_id=recipient.id,
            payload={
                "donor_org_id": str(listing.donor.id),
                "donor_lat": listing.donor.lat,
                "donor_lng": listing.donor.lng,
                "donor_verified": listing.donor.verified,
                "recipient_org_id": str(recipient.id),
                "recipient_lat": recipient.lat,
                "recipient_lng": recipient.lng,
                "distance_km": round(distance, 4),
                "pickup_start": format_instant(listing.pickup_start),
                "pickup_end": format_instant(listing.pickup_end),
            },
        )

        # Reliability *shifts* the base rate rather than scaling it. Three
        # probabilities multiplied together compound to something nobody chose:
        # 0.86 x 0.88 x 0.85 = 0.64, i.e. a third of all claims handed back,
        # which then inflates the claim count with re-claims of the same
        # listing. Keeping each trait's influence bounded holds the aggregate
        # near `completion_base` while still letting an unreliable pair differ
        # visibly from a reliable one.
        p_complete = (
            self.config.completion_base
            * (0.70 + 0.30 * listing.donor.reliability)
            * (0.70 + 0.30 * recipient.reliability)
        )
        if self._rng_outcome.random() < p_complete:
            # Collected during the window, or a little after it — a donor marks
            # a pickup done when they get round to it.
            floor = max(when, listing.pickup_start)
            span = max(0.25, (listing.pickup_end - floor).total_seconds() / 3600.0)
            at = floor + timedelta(hours=self._rng_outcome.random() * span)
            listing.status = "completing"
            self._schedule(at, _OUTCOME, listing.id)
        else:
            # Handed back, earlier rather than later: a recipient who cannot
            # make it usually knows soon.
            span = max(0.25, (listing.pickup_end - when).total_seconds() / 3600.0)
            at = when + timedelta(hours=self._rng_outcome.random() ** 2 * span)
            listing.status = "releasing"
            self._schedule(at, _OUTCOME, listing.id)

    def _on_outcome(self, listing: _Listing, when: datetime) -> Iterator[Event]:
        if listing.status not in ("completing", "releasing"):
            return  # a withdrawal got here first
        recipient = listing.recipient
        claim_id = listing.claim_id
        claimed_at = listing.claimed_at
        assert recipient is not None and claim_id is not None and claimed_at is not None

        self._recipient_load[recipient.id] -= 1

        if listing.status == "completing":
            listing.status = "completed"
            self.stats.claims_completed += 1
            yield Event(
                occurred_at=when,
                event_type="claim_completed",
                listing_id=listing.id,
                claim_id=claim_id,
                actor_org_id=listing.donor.id,
                payload={
                    "donor_org_id": str(listing.donor.id),
                    "recipient_org_id": str(recipient.id),
                    "pickup_end": format_instant(listing.pickup_end),
                    "claimed_at": format_instant(claimed_at),
                },
            )
            return

        # Released: the listing goes back on offer, exactly as `release_claim`
        # does. It can still be claimed again, and it can still end up wasted —
        # a released listing is not a withdrawn one.
        listing.status = "open"
        listing.claim_id = None
        listing.recipient = None
        listing.claimed_at = None
        self.stats.claims_cancelled += 1

        yield Event(
            occurred_at=when,
            event_type="claim_cancelled",
            listing_id=listing.id,
            claim_id=claim_id,
            actor_org_id=recipient.id,
            payload={
                "donor_org_id": str(listing.donor.id),
                "recipient_org_id": str(recipient.id),
                "pickup_end": format_instant(listing.pickup_end),
                "claimed_at": format_instant(claimed_at),
                "cancelled_by": "recipient",
            },
        )

        if when < listing.pickup_end:
            self._mark_open(listing)
            listing.rounds += 1
            if listing.rounds <= _MAX_CLAIM_ROUNDS:
                self._schedule_claim_attempt(listing, when)

    def _on_withdraw(self, listing: _Listing, when: datetime) -> Iterator[Event]:
        if listing.status in ("completed", "cancelled"):
            return
        if when >= listing.pickup_end:
            return

        displaced_claim = listing.claim_id
        displaced_recipient = listing.recipient
        displaced_claimed_at = listing.claimed_at

        if displaced_recipient is not None:
            self._recipient_load[displaced_recipient.id] -= 1

        self._mark_not_open(listing)
        listing.status = "cancelled"
        self.stats.listings_cancelled += 1

        yield Event(
            occurred_at=when,
            event_type="listing_cancelled",
            listing_id=listing.id,
            claim_id=displaced_claim,
            actor_org_id=listing.donor.id,
            payload={
                "donor_org_id": str(listing.donor.id),
                "pickup_end": format_instant(listing.pickup_end),
                "cancelled_by": "donor",
                "displaced_claim_id": None if displaced_claim is None else str(displaced_claim),
                "displaced_recipient_org_id": (
                    None if displaced_recipient is None else str(displaced_recipient.id)
                ),
                "displaced_claimed_at": (
                    None if displaced_claimed_at is None else format_instant(displaced_claimed_at)
                ),
            },
        )

    def _on_close(self, listing: _Listing) -> None:
        """`pickup_end` arrived. Emits nothing, by design."""
        if listing.status == "open":
            self.stats.wasted += 1
            self._mark_not_open(listing)


def simulate(config: SimulationConfig) -> tuple[Iterator[Event], SimulationStats]:
    """Convenience wrapper: the event stream and the stats object it fills.

    `stats` is only complete once the iterator is exhausted — it is the same
    object the run mutates, handed over early so a streaming sink can report on
    it afterwards without holding the events.
    """
    sim = Simulation(config)
    return sim.run(), sim.stats
