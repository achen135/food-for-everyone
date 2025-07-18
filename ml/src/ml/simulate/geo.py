"""Where the simulated organizations sit, and how far apart they are.

The corpus is set in the Chicago metro because that is where FFE's own seed
data is (`supabase/seed/organizations.ts` — 30 orgs at real geocoded Chicago
addresses). Keeping the synthetic corpus in the same metro means a feature
computed on simulated events and the same feature computed on FFE's backfilled
real events land in the same coordinate range, so the two can be plotted
against each other in M13 without a projection step apologising for the gap.

## The clustering is the point

Uniformly scattered points would make distance an almost useless feature:
every donor would have about the same number of recipients within 15 km, and
"recipients in radius = 0" — one of M12's two baselines — could never fire.
Real cities are not uniform. Restaurants and grocers concentrate in commercial
strips; pantries and shelters sit in the neighbourhoods they serve, which
overlap those strips only partly. That mismatch is what makes some listings
hard to place, and a simulator that smoothed it out would be generating a
problem with no signal in it.

So each cluster carries a `donor_weight` and a `recipient_weight`, and they
differ: the Loop is dense with donors and thin on recipients, the far South and
West sides the other way round. **This is an assumption, not an observation** —
see `ml/docs/simulator.md`. It bounds what any distance feature can claim.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Final

__all__ = ["CLUSTERS", "Cluster", "haversine_km", "sample_point"]

#: Mean earth radius, the value PostGIS uses for spherical work.
EARTH_RADIUS_KM: Final[float] = 6371.0088

#: Coordinates are rounded to this many decimals, matching the precision
#: `supabase/seed/organizations.ts` bakes in from Nominatim (~0.1 m). Also
#: keeps float formatting stable in the JSONL stream.
COORD_DECIMALS: Final[int] = 6


@dataclass(frozen=True, slots=True)
class Cluster:
    """A named concentration of organizations.

    `spread_km` is the standard deviation of an isotropic Gaussian around
    `(lat, lng)`, so roughly two thirds of a cluster's orgs land within that
    distance of its centre and the tails overlap neighbouring clusters — which
    is what stops the map looking like a set of disjoint islands.
    """

    name: str
    lat: float
    lng: float
    spread_km: float
    donor_weight: float
    recipient_weight: float


#: Twenty-four concentrations across the Chicago metro, city core outward to
#: the collar counties. Centres are approximate real locations; the weights are
#: invented (see module docstring).
#:
#: **The outer ring is the important part.** An earlier version of this table
#: covered only the city and inner suburbs — roughly 30 km across — with 430
#: recipients spread over it. At that density every single donor had more
#: recipients in reach than the candidate cap allowed, so distance discriminated
#: nothing and "recipients in radius = 0" was a condition that could never
#: occur. The corpus had geography in it but no geographic *signal*, and one of
#: M12's two baselines would have been measuring an empty set.
#:
#: The metro is really ~80 km across. Restoring that, and giving the outer
#: clusters a donor weight comparable to the inner ones but a recipient weight
#: three to five times lower, reproduces the thing that actually makes rural and
#: exurban food rescue hard: the surplus is there and nobody is close enough to
#: collect it.
CLUSTERS: Final[tuple[Cluster, ...]] = (
    # -- city core: dense in donors, mixed in recipients ---------------------
    Cluster("Loop", 41.8836, -87.6270, 1.6, 5.00, 1.20),
    Cluster("Near North Side", 41.9000, -87.6280, 1.8, 4.20, 1.00),
    Cluster("West Loop", 41.8830, -87.6500, 1.5, 3.60, 0.90),
    Cluster("Lincoln Park", 41.9250, -87.6480, 2.0, 3.00, 1.10),
    Cluster("Lakeview", 41.9400, -87.6540, 2.0, 2.80, 1.20),
    Cluster("Logan Square", 41.9290, -87.7070, 2.2, 2.20, 1.80),
    Cluster("Pilsen", 41.8560, -87.6560, 1.7, 1.60, 2.40),
    Cluster("Bronzeville", 41.8180, -87.6180, 2.1, 1.10, 2.60),
    Cluster("Hyde Park", 41.7940, -87.5900, 1.9, 1.40, 2.00),
    Cluster("Austin", 41.8900, -87.7600, 2.4, 0.90, 3.00),
    Cluster("Englewood", 41.7790, -87.6420, 2.2, 0.60, 3.20),
    Cluster("Rogers Park", 42.0100, -87.6720, 1.8, 1.30, 1.70),
    # -- inner suburbs -------------------------------------------------------
    Cluster("Evanston", 42.0450, -87.6880, 2.0, 1.80, 1.20),
    Cluster("Oak Park", 41.8850, -87.7845, 2.0, 1.50, 1.30),
    Cluster("Cicero", 41.8456, -87.7539, 2.0, 1.20, 1.40),
    Cluster("Skokie", 42.0324, -87.7416, 2.2, 1.30, 0.90),
    # -- outer ring: surplus with nobody near enough to take it -------------
    Cluster("Schaumburg", 42.0334, -88.0834, 3.0, 1.60, 0.35),
    Cluster("Naperville", 41.7508, -88.1535, 3.0, 1.50, 0.30),
    Cluster("Orland Park", 41.6303, -87.8539, 3.0, 1.00, 0.30),
    Cluster("Aurora", 41.7606, -88.3201, 3.5, 1.10, 0.40),
    Cluster("Joliet", 41.5250, -88.0817, 3.5, 0.90, 0.35),
    Cluster("Waukegan", 42.3636, -87.8448, 3.0, 0.80, 0.40),
    Cluster("Elgin", 42.0354, -88.2826, 3.0, 0.70, 0.30),
    Cluster("Gary", 41.5934, -87.3464, 3.0, 0.60, 0.45),
)


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometres.

    PostGIS `ST_Distance` on `geography` is geodesic on the WGS84 spheroid;
    this is spherical, which runs about 0.3–0.5% short at these latitudes. That
    gap is far below the resolution of any feature built on it (the smallest
    radius bucket M12 uses is 5 km) and it is applied uniformly, so it shifts no
    comparison. Documented rather than corrected because a spheroid solver here
    would be precision theatre on invented coordinates.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def sample_point(rng: random.Random, cluster: Cluster) -> tuple[float, float]:
    """Draw a coordinate inside `cluster`, consuming exactly two draws."""
    # Degrees per km: latitude is constant, longitude narrows with latitude.
    dlat_km = 1.0 / 110.574
    dlng_km = 1.0 / (111.320 * math.cos(math.radians(cluster.lat)))

    lat = cluster.lat + rng.normalvariate(0.0, cluster.spread_km) * dlat_km
    lng = cluster.lng + rng.normalvariate(0.0, cluster.spread_km) * dlng_km
    return round(lat, COORD_DECIMALS), round(lng, COORD_DECIMALS)
