"""Every tunable of the generative model, in one place.

This module is the short form of `ml/docs/simulator.md`. It is deliberately
all-constants-no-logic: the assumptions that bound what a downstream metric can
claim should be readable without tracing control flow, and a reviewer asking
"what did you assume about how fast pantries respond?" should find the number,
not a call site.

Nothing here was measured. FFE has no real traffic — that is the reason the
simulator exists (`docs/ML Subsystem.md` §2). These are plausible values chosen
to produce a problem with learnable structure and a non-trivial base rate. The
honest framing, used everywhere downstream: **a model trained on this learns
the structure encoded here, so its metrics describe this file.**
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

__all__ = [
    "CATEGORY_TITLES",
    "FOOD_CATEGORIES",
    "POST_HOUR_WEIGHT",
    "WEEKDAY_WEIGHT",
    "SimulationConfig",
]

#: Mean days per month, so `--months 6` is 183 days rather than 180.
DAYS_PER_MONTH: Final[float] = 30.437

#: The corpus starts at a fixed instant, never at `now`.
#:
#: `supabase/seed/activity.ts` deliberately slides its window relative to the
#: current time, so a freshly seeded dashboard always shows 90 recent days. The
#: opposite choice is right here: this corpus is training data, and "same seed →
#: byte-identical stream" cannot hold if the timestamps move every day. It also
#: means M12's committed `baselines.json` stays reproducible next month.
#:
#: The date sits on the repo's synthetic 2025 timeline (see the commit history).
DEFAULT_START: Final[datetime] = datetime(2025, 1, 6, 0, 0, 0, tzinfo=UTC)

#: What gets donated. Each carries a latent desirability and a perishability;
#: prepared meals move fast or not at all, dry goods keep.
FOOD_CATEGORIES: Final[tuple[str, ...]] = (
    "prepared_meals",
    "produce",
    "bakery",
    "dairy",
    "dry_goods",
    "frozen",
    "beverages",
)

#: How appealing a category is to a recipient — a multiplier on the claim
#: hazard. Produce and prepared meals go quickly; beverages sit.
CATEGORY_DESIRABILITY: Final[dict[str, float]] = {
    "prepared_meals": 1.15,
    "produce": 1.30,
    "bakery": 1.05,
    "dairy": 1.00,
    "dry_goods": 0.90,
    "frozen": 0.85,
    "beverages": 0.60,
}

#: Titles are drawn from these, so `title` carries category signal the way a
#: real one would without any free text leaving the simulator.
CATEGORY_TITLES: Final[dict[str, tuple[str, ...]]] = {
    "prepared_meals": (
        "Hot meal trays",
        "Surplus prepared meals",
        "Catering overflow",
        "Deli counter surplus",
    ),
    "produce": ("Mixed produce cases", "Seasonal vegetables", "Fruit overstock", "Salad greens"),
    "bakery": ("Day-old bread", "Bakery overstock", "Pastry surplus", "Sandwich rolls"),
    "dairy": ("Milk and yoghurt", "Short-date dairy", "Cheese ends", "Butter overstock"),
    "dry_goods": ("Pantry staples", "Rice and pasta", "Tinned goods", "Dry goods pallet"),
    "frozen": ("Frozen vegetables", "Frozen entrees", "Freezer overstock", "Frozen protein"),
    "beverages": ("Bottled water", "Juice cases", "Soft drinks", "Coffee overstock"),
}

#: Sunday-first, matching `supabase/seed/activity.ts` so the two data sets have
#: the same weekly rhythm. Fridays clear the most stock; Sundays the least.
WEEKDAY_WEIGHT: Final[tuple[float, ...]] = (0.45, 1.00, 1.00, 1.00, 1.05, 1.35, 0.70)

#: Relative likelihood a listing is posted in each hour, UTC-naive local time.
#: Two humps — a late-morning one as kitchens finish prep and count stock, and a
#: much larger evening one at close of service, which is when surplus is
#: actually known. The overnight trough is not zero: bakeries exist.
POST_HOUR_WEIGHT: Final[tuple[float, ...]] = (
    0.10,
    0.08,
    0.06,
    0.08,
    0.20,
    0.45,
    0.70,
    0.90,  # 00–07
    1.10,
    1.35,
    1.50,
    1.30,
    1.10,
    1.00,
    1.05,
    1.25,  # 08–15
    1.60,
    2.10,
    2.60,
    2.80,
    2.30,
    1.60,
    0.90,
    0.35,  # 16–23
)

#: Recipients are organizations with opening hours. A pantry does not claim a
#: listing at 04:00, and a model that never saw that would treat a 3am posting
#: as no harder to place than a 3pm one.
RECIPIENT_ACTIVE_HOURS: Final[tuple[int, int]] = (7, 21)


@dataclass(frozen=True, slots=True)
class SimulationConfig:
    """Population sizes and behavioural rates.

    Defaults land a little over 110,000 `listing_posted` events across six
    simulated months, clearing the ≥100k / ≥6 months floor in
    `docs/ML Subsystem.md` §5 with enough margin that a tuning change does not
    quietly drop the corpus under it. `ml/tests/test_volume.py` asserts the
    floor rather than trusting this comment.
    """

    seed: int = 20250718
    months: int = 6
    start: datetime = DEFAULT_START

    # --- population -------------------------------------------------------
    n_donors: int = 700
    n_recipients: int = 430

    #: Listings per donor per day, lognormal. `mu`/`sigma` are of the
    #: underlying normal, so the median donor posts exp(mu) and the tail is
    #: long: a few high-volume grocers dominate, as they do in practice.
    donor_rate_mu: float = -0.28
    donor_rate_sigma: float = 0.62

    #: Share of donors flagged `verified`. Verification correlates with volume
    #: and with claim rate, which is what makes `donor_verified` a real feature
    #: rather than noise.
    donor_verified_share: float = 0.55

    # --- listing shape ----------------------------------------------------
    #: Hours between posting and `pickup_start`. Short and right-skewed: most
    #: surplus is announced for the same evening.
    lead_time_mu: float = 0.55
    lead_time_sigma: float = 0.95

    #: Length of the pickup window itself.
    window_mu: float = 1.75
    window_sigma: float = 0.65
    window_min_hours: float = 1.0
    window_max_hours: float = 72.0

    #: `notes_length` — a Poisson-ish draw scaled by a per-donor verbosity.
    #: The text never exists, only its length (the contract forbids the text).
    notes_length_mean: float = 68.0

    # --- claiming ---------------------------------------------------------
    #: Base hazard, claims per hour, for one candidate recipient at zero
    #: distance with a neutral category. Everything else multiplies this.
    claim_hazard_base: float = 0.090

    #: Hazard decays with distance: multiplier is exp(-distance_km / this).
    #: At 10 km a recipient is ~0.55x as likely to move as one next door.
    distance_decay_km: float = 12.0

    #: How many nearby recipients are considered for one listing. Beyond this
    #: the marginal candidate is far enough that its hazard is negligible, and
    #: the cap keeps the inner loop linear in listings rather than in
    #: listings x recipients.
    candidate_limit: int = 40

    #: Multiplier on the hazard when the donor is verified.
    verified_hazard_bonus: float = 1.22

    #: Competition. Each other listing open within 15 km at post time divides
    #: the hazard by (1 + count * this). Recipients have finite trips to make.
    competition_penalty: float = 0.006

    #: Larger loads are harder to place — a pantry needs the storage.
    quantity_penalty: float = 0.055

    # --- outcomes ---------------------------------------------------------
    #: Probability a claim ends in `claim_completed` rather than
    #: `claim_cancelled`, before the donor's and recipient's reliability
    #: traits shift it.
    completion_base: float = 0.93

    #: Probability a donor withdraws a listing before its window closes. Split
    #: out because it is the reason the fifth event type exists: a withdrawn
    #: listing is not wasted food, and the label must not count it.
    withdraw_rate_mu: float = 0.045
    withdraw_rate_sigma: float = 0.030

    @property
    def days(self) -> int:
        """Simulated days. `months` is the unit the CLI and §5 speak in."""
        return max(1, round(self.months * DAYS_PER_MONTH))

    @property
    def end(self) -> datetime:
        from datetime import timedelta

        return self.start + timedelta(days=self.days)
