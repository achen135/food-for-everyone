"""Organizations and their latent traits.

The traits here are the part of the simulator that matters most for what a
model can learn, and the part most easily overdone. `docs/ML Subsystem.md` §2
sets the constraint plainly: *the generator's latent structure is capped and
documented*, because a model can only learn structure the simulator put in, and
a simulator with fifteen interacting latents produces a corpus where a
sufficiently large model scores beautifully and the number means nothing.

**The cap: five latents per donor, four per recipient, each with a stated
real-world referent, and no latent is exposed as a feature.** A donor's
`appeal` shifts how fast its listings get claimed but never appears in the
event stream — the pipeline can only infer it from that donor's observed
history, which is exactly the inference a real model would have to make.

What is deliberately *not* modelled is listed in `ml/docs/simulator.md` under
"What this does not model". That list is as important as this file: it is the
set of things a metric computed on this corpus is silent about.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from uuid import UUID

from ml.simulate.config import FOOD_CATEGORIES, SimulationConfig
from ml.simulate.geo import CLUSTERS, Cluster, sample_point
from ml.simulate.rng import new_uuid, substream

__all__ = ["Donor", "Population", "Recipient", "build_population"]


@dataclass(frozen=True, slots=True)
class Donor:
    """A restaurant or grocer.

    Latents (5): `rate`, `appeal`, `reliability`, `withdraw_rate`,
    `capacity_scale`. `verified` is observable — it ships in every
    `listing_posted` payload — and so is not a latent; it is correlated with
    `rate` and `appeal` on purpose, which is what makes it a useful but
    imperfect proxy for them.
    """

    id: UUID
    cluster: Cluster
    lat: float
    lng: float

    #: Mean listings per day.
    rate: float
    verified: bool

    #: Latent. How readily this donor's listings get taken — a stand-in for
    #: everything the log does not record: dock access, staff who answer the
    #: phone, whether the food is actually as described. Inferable only from
    #: the donor's own history, which is the point.
    appeal: float

    #: Latent. Propensity to see a claim through to `claim_completed`.
    reliability: float

    #: Latent. Per-listing probability of withdrawing the offer.
    withdraw_rate: float

    #: Latent. Scales `quantity` — a hotel kitchen posts bigger loads than a
    #: cafe, and bigger loads are harder to place.
    capacity_scale: float

    #: Observable-ish: drives `title`, and correlates with perishability.
    categories: tuple[str, ...]

    #: Mean `notes_length` for this donor. Some write a paragraph, some write
    #: nothing, and how much a donor bothers to write correlates with `appeal`.
    notes_verbosity: float


@dataclass(frozen=True, slots=True)
class Recipient:
    """A food bank, pantry or shelter.

    Latents (4): `responsiveness`, `radius_km`, `capacity`, `reliability`.
    """

    id: UUID
    cluster: Cluster
    lat: float
    lng: float

    #: Latent. Multiplier on the claim hazard — staffing, essentially.
    responsiveness: float

    #: Latent. How far this organization will travel for a pickup. The single
    #: most consequential recipient trait: it is what makes "no recipients in
    #: radius" a real condition rather than an arithmetic one.
    radius_km: float

    #: Latent. Concurrent active claims this organization will hold. A pantry
    #: with one van cannot take six pickups at once, and this is what couples
    #: listings to each other — without it, every listing would be an
    #: independent draw and local competition would not exist.
    capacity: int

    #: Latent. Propensity to complete rather than hand a claim back.
    reliability: float

    #: Which categories this organization takes. A shelter with no freezer
    #: does not claim frozen goods.
    categories: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Population:
    donors: tuple[Donor, ...]
    recipients: tuple[Recipient, ...]


def _pick_cluster(rng: random.Random, weight_attr: str) -> Cluster:
    """Choose a cluster by its donor or recipient weight.

    Iterates `CLUSTERS`, a tuple, in declaration order — never a set, never a
    dict built from one (see `ml.simulate.rng`).
    """
    total = 0.0
    for cluster in CLUSTERS:
        total += getattr(cluster, weight_attr)
    target = rng.random() * total
    upto = 0.0
    for cluster in CLUSTERS:
        upto += getattr(cluster, weight_attr)
        if target < upto:
            return cluster
    return CLUSTERS[-1]


def _pick_categories(rng: random.Random, count: int) -> tuple[str, ...]:
    """A sorted, de-duplicated selection from `FOOD_CATEGORIES`.

    Sorted so the tuple is a canonical value: two donors with the same
    categories compare equal regardless of draw order, and the JSONL bytes do
    not depend on it.
    """
    chosen = rng.sample(list(FOOD_CATEGORIES), count)
    return tuple(sorted(chosen))


def build_population(config: SimulationConfig) -> Population:
    """Generate donors and recipients deterministically from `config.seed`.

    Two substreams rather than one shared generator, so changing the number of
    recipients does not shift a single donor's traits. That property is what
    makes the volume knobs safe to turn.
    """
    donor_rng = substream(config.seed, "population/donors")
    recipient_rng = substream(config.seed, "population/recipients")

    donors: list[Donor] = []
    for _ in range(config.n_donors):
        cluster = _pick_cluster(donor_rng, "donor_weight")
        lat, lng = sample_point(donor_rng, cluster)

        rate = donor_rng.lognormvariate(config.donor_rate_mu, config.donor_rate_sigma)
        rate = min(rate, 8.0)  # nobody posts 40 times a day

        # Appeal first, then verification conditioned on it: a verified donor
        # is more likely to be a good one, but plenty of good ones never got
        # round to verifying. That imperfect correlation is what stops
        # `donor_verified` standing in for the latent outright.
        appeal = donor_rng.lognormvariate(0.0, 0.42)
        verified_p = config.donor_verified_share * (0.6 + 0.5 * min(appeal, 2.0))
        verified = donor_rng.random() < min(verified_p, 0.94)

        donors.append(
            Donor(
                id=new_uuid(donor_rng),
                cluster=cluster,
                lat=lat,
                lng=lng,
                rate=rate,
                verified=verified,
                appeal=appeal,
                reliability=min(1.0, max(0.0, donor_rng.normalvariate(0.88, 0.10))),
                withdraw_rate=min(
                    0.30,
                    max(
                        0.0,
                        donor_rng.normalvariate(
                            config.withdraw_rate_mu, config.withdraw_rate_sigma
                        ),
                    ),
                ),
                capacity_scale=donor_rng.lognormvariate(0.0, 0.55),
                categories=_pick_categories(donor_rng, donor_rng.randint(1, 3)),
                notes_verbosity=max(0.0, donor_rng.normalvariate(1.0, 0.45)),
            )
        )

    recipients: list[Recipient] = []
    for _ in range(config.n_recipients):
        cluster = _pick_cluster(recipient_rng, "recipient_weight")
        lat, lng = sample_point(recipient_rng, cluster)

        # Radius is the trait that decides whether a donor has anyone at all.
        # Right-skewed: most organizations work a neighbourhood, a few run a
        # regional operation with a truck.
        radius = min(30.0, max(2.0, recipient_rng.lognormvariate(1.95, 0.55)))

        recipients.append(
            Recipient(
                id=new_uuid(recipient_rng),
                cluster=cluster,
                lat=lat,
                lng=lng,
                responsiveness=recipient_rng.lognormvariate(0.0, 0.50),
                radius_km=radius,
                capacity=max(1, int(recipient_rng.lognormvariate(0.75, 0.60))),
                reliability=min(1.0, max(0.0, recipient_rng.normalvariate(0.85, 0.12))),
                categories=_pick_categories(recipient_rng, recipient_rng.randint(3, 6)),
            )
        )

    return Population(donors=tuple(donors), recipients=tuple(recipients))
