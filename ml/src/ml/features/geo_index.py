"""Incremental spatial index over organizations discovered in the log.

The market features — recipients in radius, open listings nearby, recent claims
nearby — are the expensive ones. Computed naively they are a distance query per
observation against every organization seen so far: ~900k observations against
hundreds of sites is hundreds of millions of haversine calls, which turns
`make features` into something nobody runs.

## The shape that makes it cheap

Every listing is posted at its donor's location, and there are only a few
hundred distinct donors. So the counters are kept **per donor**, not per
listing, and they are updated when the world changes rather than read when a
question is asked:

- a listing opens → increment `open_nearby` for every donor within 15 km
- a listing closes → decrement the same
- a recipient is seen for the first time → increment `recipients_within_*` for
  every donor in range

An observation then reads a single array element. The work moves from ~900k
queries to ~240k updates, and each update is one vectorised numpy write.

## Entities are added only when the log reveals them

`add_donor` is called when a donor first posts; `add_recipient` when a recipient
first claims. Nothing is precomputed from the corpus as a whole, because a count
that included an organization not yet seen at `as_of` would be leakage — of the
most plausible kind, since the coordinates are static and it feels harmless to
load them up front. It is not: "how many recipients are near this donor" is a
statement about what is *known*, and the log has no organization-registration
event to know it from any earlier.
"""

from __future__ import annotations

import math
from typing import cast

import numpy as np

from ml.simulate.geo import EARTH_RADIUS_KM

__all__ = ["NeighbourIndex"]


def _haversine_vector(lat: float, lng: float, lats: np.ndarray, lngs: np.ndarray) -> np.ndarray:
    """Distance in km from one point to many. Same formula as
    `ml.simulate.geo.haversine_km`, vectorised — the two are checked against
    each other in `ml/tests/test_features.py`."""
    phi1 = math.radians(lat)
    phi2 = np.radians(lats)
    dphi = phi2 - phi1
    dlambda = np.radians(lngs - lng)
    a = np.sin(dphi / 2.0) ** 2 + math.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2.0) ** 2
    return cast(np.ndarray, 2.0 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0))))


class NeighbourIndex:
    """Donor-to-donor adjacency and per-donor recipient counts, built as the
    log is read.

    `market_radius_km` governs donor adjacency (open listings, recent claims);
    `near_radius_km` is the tighter recipient bucket.
    """

    def __init__(self, near_radius_km: float, market_radius_km: float) -> None:
        self.near_radius_km = near_radius_km
        self.market_radius_km = market_radius_km

        self._donor_index: dict[str, int] = {}
        self._donor_lat: list[float] = []
        self._donor_lng: list[float] = []

        self._recipient_ids: set[str] = set()
        self._recipient_lat: list[float] = []
        self._recipient_lng: list[float] = []

        # Adjacency as growable Python lists, materialised to numpy on demand.
        # Appending to a numpy array reallocates; appending to a list does not,
        # and the arrays are only needed at update time.
        self._neighbours: list[list[int]] = []
        self._neighbour_cache: list[np.ndarray | None] = []

        # Per-donor counters, reallocated as donors appear.
        #
        # The `_own` arrays are what this donor alone contributes; the `_nearby`
        # arrays are the sum over its neighbourhood. Both are needed because the
        # adjacency **grows**: a donor that first posts in March has neighbours
        # whose listings and claims happened in January, and those increments
        # were applied to a neighbour list that did not yet contain it. Without
        # the `_own` totals to initialise from, its `_nearby` counts would start
        # at zero and stay permanently short — and the decrements, applied
        # through the now-larger neighbour list, would drive other donors'
        # counters negative. This was a real bug, caught by the leakage guard
        # comparing against `reference.py`.
        self.recipients_near = np.zeros(0, dtype=np.int32)
        self.recipients_market = np.zeros(0, dtype=np.int32)
        self.open_own = np.zeros(0, dtype=np.int32)
        self.open_nearby = np.zeros(0, dtype=np.int32)
        self.claims_own = np.zeros(0, dtype=np.int32)
        self.claims_nearby = np.zeros(0, dtype=np.int32)

    # -- growth -----------------------------------------------------------

    def _grow_counters(self) -> None:
        size = len(self._donor_lat)
        for name in (
            "recipients_near",
            "recipients_market",
            "open_own",
            "open_nearby",
            "claims_own",
            "claims_nearby",
        ):
            current: np.ndarray = getattr(self, name)
            grown = np.zeros(size, dtype=np.int32)
            grown[: current.shape[0]] = current
            setattr(self, name, grown)

    def donor_id_index(self, donor_id: str) -> int | None:
        return self._donor_index.get(donor_id)

    def add_donor(self, donor_id: str, lat: float, lng: float) -> int:
        """Register a donor the first time it posts. Idempotent."""
        existing = self._donor_index.get(donor_id)
        if existing is not None:
            return existing

        index = len(self._donor_lat)
        existing_lat = np.asarray(self._donor_lat, dtype=np.float64)
        existing_lng = np.asarray(self._donor_lng, dtype=np.float64)

        self._donor_index[donor_id] = index
        self._donor_lat.append(lat)
        self._donor_lng.append(lng)
        self._neighbours.append([index])  # a donor is its own neighbour
        self._neighbour_cache.append(None)
        self._grow_counters()

        # Adjacency is symmetric: the new donor joins the neighbour lists of
        # everyone already in range, and they join its.
        if index:
            distances = _haversine_vector(lat, lng, existing_lat, existing_lng)
            for other in np.flatnonzero(distances <= self.market_radius_km):
                other_index = int(other)
                self._neighbours[other_index].append(index)
                self._neighbour_cache[other_index] = None
                self._neighbours[index].append(other_index)
            self._neighbour_cache[index] = None

        # Seed the new donor's neighbourhood counters from what its neighbours
        # are already carrying. Everything open near here, and every recent
        # claim near here, was true before this donor posted and is part of the
        # market it is posting into.
        neighbours = self.neighbours(index)
        self.open_nearby[index] = int(self.open_own[neighbours].sum())
        self.claims_nearby[index] = int(self.claims_own[neighbours].sum())

        # Recipients already seen count towards this donor immediately — they
        # were known before it posted.
        if self._recipient_lat:
            distances = _haversine_vector(
                lat,
                lng,
                np.asarray(self._recipient_lat, dtype=np.float64),
                np.asarray(self._recipient_lng, dtype=np.float64),
            )
            self.recipients_near[index] = int(np.count_nonzero(distances <= self.near_radius_km))
            self.recipients_market[index] = int(
                np.count_nonzero(distances <= self.market_radius_km)
            )
        return index

    def add_recipient(self, recipient_id: str, lat: float, lng: float) -> bool:
        """Register a recipient the first time it claims. Returns whether it was
        new, so the caller can skip work on the (overwhelmingly common) repeat.
        """
        if recipient_id in self._recipient_ids:
            return False
        self._recipient_ids.add(recipient_id)
        self._recipient_lat.append(lat)
        self._recipient_lng.append(lng)

        if self._donor_lat:
            distances = _haversine_vector(
                lat,
                lng,
                np.asarray(self._donor_lat, dtype=np.float64),
                np.asarray(self._donor_lng, dtype=np.float64),
            )
            self.recipients_near[distances <= self.near_radius_km] += 1
            self.recipients_market[distances <= self.market_radius_km] += 1
        return True

    # -- updates ----------------------------------------------------------

    def neighbours(self, donor_index: int) -> np.ndarray:
        cached = self._neighbour_cache[donor_index]
        if cached is None:
            cached = np.asarray(self._neighbours[donor_index], dtype=np.intp)
            self._neighbour_cache[donor_index] = cached
        return cached

    def bump_open(self, donor_index: int, delta: int) -> None:
        self.open_own[donor_index] += delta
        self.open_nearby[self.neighbours(donor_index)] += delta

    def bump_claims(self, donor_index: int, delta: int) -> None:
        self.claims_own[donor_index] += delta
        self.claims_nearby[self.neighbours(donor_index)] += delta

    @property
    def donor_count(self) -> int:
        return len(self._donor_lat)

    @property
    def recipient_count(self) -> int:
        return len(self._recipient_ids)
