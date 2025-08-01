"""The feature contract: which columns exist, in what order, of what type.

One ordered list, imported by the reference implementation, the streaming
pipeline, the database writer and the leakage guard. Keeping it in one place is
what lets the guard compare two independent computations field by field and
report *which* feature disagreed rather than "the rows differ".

## The rule every feature obeys

**A feature's value at `as_of` is a pure function of events with
`occurred_at <= as_of`.** No exceptions, and `label` is not a counter-example —
it is not a feature, it is the thing being predicted, and it is derived from
the listing's future on purpose.

The rule is not enforced by convention. `ml/tests/test_leakage.py` recomputes a
sample of rows from a filtered event list and asserts equality, and separately
asserts that handing the reference implementation the *entire* log produces
identical values — which it can only do if nothing inside it looks past `as_of`.
"""

from __future__ import annotations

from typing import Final, Literal

FeatureKind = Literal["float", "int", "bool", "text"]

#: (column, kind, nullable). Order is the database column order and the order
#: the leakage guard reports in.
FEATURE_COLUMNS: Final[tuple[tuple[str, FeatureKind, bool], ...]] = (
    # -- listing-intrinsic: everything in the listing_posted payload, plus the
    #    clock. Available at post time; only the as_of-relative ones move.
    ("hours_to_pickup_end", "float", False),
    ("hours_since_posted", "float", False),
    ("lead_time_hours", "float", False),
    ("pickup_window_hours", "float", False),
    ("quantity_units", "float", True),
    ("notes_length", "int", False),
    ("food_category", "text", True),
    ("donor_verified", "bool", False),
    ("donor_lat", "float", False),
    ("donor_lng", "float", False),
    ("posted_hour", "int", False),
    ("posted_dow", "int", False),
    ("as_of_hour", "int", False),
    ("as_of_dow", "int", False),
    ("pickup_end_hour", "int", False),
    # -- donor track record, over that donor's PRIOR listings only.
    ("donor_prior_listings", "int", False),
    ("donor_prior_claim_rate", "float", True),
    ("donor_prior_completion_rate", "float", True),
    ("donor_prior_cancel_rate", "float", True),
    ("donor_hours_since_last_post", "float", True),
    ("donor_median_claim_latency", "float", True),
    # -- local market conditions as of the observation.
    ("recipients_within_5km", "int", False),
    ("recipients_within_15km", "int", False),
    ("open_listings_within_15km", "int", False),
    ("claims_within_15km_prior_7d", "int", False),
)

FEATURE_NAMES: Final[tuple[str, ...]] = tuple(name for name, _, _ in FEATURE_COLUMNS)

#: Written alongside the features; not features.
KEY_COLUMNS: Final[tuple[str, ...]] = ("listing_id", "as_of")
TARGET_COLUMNS: Final[tuple[str, ...]] = ("label", "split")

ALL_COLUMNS: Final[tuple[str, ...]] = KEY_COLUMNS + FEATURE_NAMES + TARGET_COLUMNS

#: Radii the market features use, in kilometres.
NEAR_RADIUS_KM: Final[float] = 5.0
MARKET_RADIUS_KM: Final[float] = 15.0

#: Window for `claims_within_15km_prior_7d`.
CLAIM_WINDOW_HOURS: Final[float] = 24.0 * 7.0

#: Observations are taken at post time and then on this cadence while the
#: listing is open — mirroring §1's "scored at post time and re-scored hourly".
OBSERVATION_INTERVAL_HOURS: Final[float] = 1.0

#: Tolerance for comparing two independently computed float features. They are
#: computed by different code paths in a different order, so exact equality is
#: the wrong assertion; this is tight enough that a real leak cannot hide under
#: it (a leaked event moves a count by a whole unit, not by 1e-9).
FLOAT_TOLERANCE: Final[float] = 1e-9
