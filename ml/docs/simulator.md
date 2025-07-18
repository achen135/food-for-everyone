# The simulator — what it assumes, and what that costs

> **Everything in the corpus is simulated.** No number produced from it
> describes real donation behaviour, and none of it is ever presented as real
> traffic (Spec §9). This document exists because a model can only learn
> structure the generator put in, so **every metric computed downstream is a
> statement about this file**, not about food rescue.

`docs/ML Subsystem.md` §2 commits to exactly one mitigation for that risk:
*the generator's latent structure is capped and documented.* This is the
documentation, and §3 below is the cap.

---

## 1. Running it

```bash
cd ml
make data                      # 6 months into Postgres, ~25 s
make data SEED=7 MONTHS=12     # a different corpus
make jsonl                     # the reference stream to out/events.jsonl
make hash                      # the determinism check, by hand
```

Or directly:

```bash
python -m ml.simulate --seed 20250718 --months 6 --out postgres
python -m ml.simulate --seed 20250718 --months 6 --out jsonl --path - | shasum -a 256
```

Committed defaults, and what they produce:

| | |
|---|---|
| seed | `20250718` |
| window | 2025-01-06 → 2025-07-08 (183 days, 6 months) |
| organizations | 700 donors, 430 recipients |
| `listing_posted` | 113,149 |
| `listing_claimed` | 96,988 |
| `claim_completed` | 80,679 |
| `claim_cancelled` | 14,138 |
| `listing_cancelled` | 4,115 |
| total rows | 309,069 |
| positive class (wasted) | 24.8% of decided listings |
| right-censored | 165 (0.15%) |
| stream sha256 | `5bd0211ae79f2fe1f662871228fad770639da6e2f273b72121e963f0ce72d3f8` |

That clears §5's floor — ≥100k listing events over ≥6 simulated months — with
about 13% margin. `ml/tests/test_volume.py` asserts the floor rather than
trusting this table.

**The window is fixed, not relative to now.** This is the one place the ml
corpus deliberately differs from `supabase/seed/activity.ts`, which slides its
90 days so a freshly seeded dashboard always looks current. Training data has
the opposite requirement: M12's committed `baselines.json` has to still
reproduce next month, and a corpus whose timestamps move cannot be
byte-identical across runs.

---

## 2. Determinism, and how it is held

Same seed → byte-identical stream. Three mechanisms, all in
`ml/src/ml/simulate/rng.py`:

1. **Named substreams.** Every draw comes from a generator derived from
   `(seed, name)` via BLAKE2b. Adding a draw to org generation cannot shift the
   numbers the behavioural loop sees, so tuning the population does not
   reshuffle the corpus — which is what keeps the determinism test from failing
   on every edit and getting deleted.
2. **No `hash()`, and no iteration over sets.** Python salts string hashing per
   process, so anything derived from it differs run to run. The generative path
   uses sorted lists and tuples throughout.
3. **`random.Random`, not numpy.** CPython guarantees the Mersenne Twister
   stream for a given seed across versions. The simulator needs no array maths,
   so it pays nothing for that guarantee.

`ml/tests/test_determinism.py` runs the CLI in **two fresh subprocesses with
different `PYTHONHASHSEED` values** and compares hashes. In-process would be
faster and would not test the thing: the salt only takes effect at interpreter
start, so a set-iteration bug is invisible to a same-process re-run.

---

## 3. The latent structure — the cap

**Five latents per donor, four per recipient. No latent is ever exposed as a
feature.** A donor's `appeal` shifts how quickly its listings are taken but
appears nowhere in the event stream; the pipeline can only infer it from that
donor's observed history, which is the inference a real model would have to
make.

### Donors (`ml/src/ml/simulate/orgs.py`)

| Latent | Real-world referent | Distribution |
|---|---|---|
| `rate` | how much surplus this business generates | lognormal(−0.28, 0.62) listings/day, capped at 8 |
| `appeal` | dock access, staff who answer the phone, food matching its description | lognormal(0, 0.42) |
| `reliability` | follows a pickup through to collection | normal(0.88, 0.10), clipped |
| `withdraw_rate` | sells the surplus, or double-posts and retracts | normal(0.045, 0.030), clipped |
| `capacity_scale` | a hotel kitchen vs. a cafe | lognormal(0, 0.55) |

`verified` is **not** a latent — it ships in every `listing_posted` payload. It
is drawn *conditioned on* `appeal`, so it is a useful but deliberately
imperfect proxy for it: a verified donor is more likely to be a good one, and
plenty of good ones never got round to verifying.

### Recipients

| Latent | Real-world referent | Distribution |
|---|---|---|
| `responsiveness` | staffing | lognormal(0, 0.50) |
| `radius_km` | how far they will travel | lognormal(1.95, 0.55), clamped to [2, 30] |
| `capacity` | concurrent pickups they can hold | lognormal(0.75, 0.60), ≥1 |
| `reliability` | completes rather than hands back | normal(0.85, 0.12), clipped |

`capacity` is the only thing in the model that **couples listings to each
other**. Without it every listing would be an independent draw and local
competition would not exist.

### Geography

24 clusters spanning the real Chicago metro footprint (~80 km), each an
isotropic Gaussian. Cluster centres are approximate real locations; the
donor/recipient weights are invented.

The outer ring — Aurora, Joliet, Waukegan, Elgin, Gary, Naperville, Schaumburg,
Orland Park — carries donor weight comparable to the inner suburbs but
**recipient weight three to five times lower**. That asymmetry is the model of
why exurban food rescue is hard: the surplus is there and nobody is close
enough to collect it.

> **This was a bug first.** The original table covered only the city, ~30 km
> across, with all 430 recipients inside it. At that density *every* donor had
> more recipients in reach than the candidate cap allowed: distance
> discriminated nothing, and "recipients in radius = 0" — one of M12's two
> baselines — was a condition that could never occur. The corpus had geography
> in it and no geographic signal. It was found by checking the candidate-count
> distribution, not by reading the code.

Resulting spread, by candidate recipients per donor: min 1, p10 5, median 40
(the cap), max 40. 13% of donors have five or fewer.

---

## 4. The behavioural model

`ml/src/ml/simulate/engine.py`. One heap, ordered by `(instant, sequence)`,
processed forward.

**Posting.** Per donor per day, a Poisson draw on `rate × weekday_weight`.
Weekday weights are Sunday-first `(0.45, 1.0, 1.0, 1.0, 1.05, 1.35, 0.70)` —
the same shape `supabase/seed/activity.ts` uses, so the two data sets have the
same weekly rhythm. Hour-of-day is a two-humped distribution: a late-morning
count and a much larger evening one at close of service, when surplus is
actually known.

**Claiming.** Each listing gets a hazard in claims/hour:

```
hazard = base
       × Σ over candidate recipients of  responsiveness × exp(−distance / 12 km)
       × donor.appeal
       × category desirability
       × 1.22 if donor.verified
       ÷ (1 + 0.006 × open listings nearby)
       ÷ (1 + 0.055 × log1p(quantity))
```

Time-to-claim is exponential on that hazard. **A draw past `pickup_end`
schedules nothing** — wasted food is a non-event, which is the whole reason
M12 has to derive the label rather than read it.

**Recipients only act between 07:00 and 21:00.** A claim time landing at 03:00
is pushed to 07:00 rather than redrawn (redrawing would bias toward short
latencies). This is the single strongest effect in the corpus — see §5.

**Outcomes.** A claim completes with probability
`0.93 × (0.70 + 0.30·donor.reliability) × (0.70 + 0.30·recipient.reliability)`,
otherwise it is released and the listing goes back on offer, exactly as
`release_claim` does. Reliability *shifts* the base rate rather than scaling
it: three probabilities multiplied together compounded to a 36% release rate
nobody chose, which then inflated the claim count with re-claims of the same
listing.

**Withdrawals** are drawn at post time and fire later, so a withdrawal can land
before or after a claim — which is what produces both the null and the
populated `displaced_*` cases the contract allows for.

### Two approximations, both deliberate

- **Competition is counted per cluster, not per radius.** The honest query is
  ~110k posts × hundreds of open listings, tens of millions of distance
  calculations, and it would dominate `make data`. Each cluster keeps a counter
  instead, and competition is read off the donor's cluster plus every cluster
  within 15 km. Coarser number, same behaviour.
- **Distance is spherical, not geodesic.** PostGIS `ST_Distance` on `geography`
  is WGS84-spheroidal; haversine runs 0.3–0.5% short at these latitudes. That
  is far below the resolution of any feature built on it and applies uniformly.

---

## 5. What the encoded signal actually is

Measured on the committed corpus. **This is the ceiling on what any model here
can learn**, and reading it is the fastest way to understand what a good PR-AUC
in M13 will and will not mean.

Positive class: 21.2% of the 111,244 listings whose outcome is both known and
not a withdrawal.

**Observed recipients within 15 km** (the proxy M12's second baseline uses):

| recipients nearby | waste rate | n |
|---|---|---|
| 1–2 | 58.9% | 1,436 |
| 3–9 | 65.8% | 10,078 |
| 10–29 | 49.0% | 8,574 |
| 30+ | 13.1% | 91,156 |

Strongest single feature, and deliberately **not monotone** — the 1–2 bucket
sits below the 3–9 bucket because the few recipients in genuinely thin areas
are, conditionally, the responsive ones. A rules baseline on this feature alone
cannot be optimal, which is part of why M13 has something to beat.

**Pickup window length:**

| window | waste rate | n |
|---|---|---|
| <2h | 30.1% | 5,707 |
| 2–4h | 28.1% | 26,271 |
| 4–8h | 24.4% | 45,193 |
| 8–24h | 10.5% | 32,518 |
| ≥24h | 3.3% | 1,555 |

**Hour of day `pickup_end` falls in** — the opening-hours mechanic, and the
sharpest effect in the corpus:

| pickup_end hour | waste rate | n |
|---|---|---|
| 00–03 | 33.2% | 26,896 |
| 04–07 | 41.8% | 18,503 |
| 08–11 | 7.9% | 11,998 |
| 12–15 | 8.9% | 13,988 |
| 16–19 | 9.0% | 16,932 |
| 20–23 | 14.1% | 22,927 |

**Donor verified:** 19.2% vs 24.3% unverified. **Category:** produce 19%,
beverages 28–29%. **Quantity:** mildly monotone, 21.4% at 1–5 units to 24.2%
above 30.

> A model that scores well here is exploiting a five-way interaction between
> geography, window length, hour of day, donor track record and category. That
> is a genuine tabular learning problem — which is the point — but it is a
> problem this repository defined.

---

## 6. What this does **not** model

As important as §5. A metric computed on this corpus is silent about every one
of these:

- **Seasonality and weather.** No holidays, no summer produce glut, no snow day
  that strands a van. Six months of statistically identical weeks.
- **Organizations joining, leaving, or changing.** The population is fixed at
  t=0 and every latent is constant. No donor gets better at posting; no pantry
  loses its refrigeration.
- **Communication outside the app.** No phone calls, no repeat relationships,
  no "we always take Tuesday's bread". Every claim decision is memoryless
  except through the shared capacity counter.
- **Any text.** `title` is drawn from four strings per category and
  `notes_length` is a number with no document behind it. Nothing here supports
  an NLP feature, and a model that appeared to benefit from one would be
  fitting the title lookup table.
- **Listing edits.** Production has no edit path for a posted listing, so
  neither does this — but that means the corpus cannot teach anything about
  amended pickup windows.
- **Adversarial or degenerate behaviour.** No spam listings, no no-shows
  recorded as completions, no duplicate posts of the same food.
- **Real address distributions.** Organizations sit at Gaussian draws around 24
  cluster centres, not at real building locations. Densities are plausible;
  they are not Chicago's.
- **Anything the event log does not carry.** Storage capacity, vehicle
  availability, volunteer schedules — the features that would matter most in
  practice — are outside the schema, so they are outside the simulator too.

---

## 7. Relationship to the production schema

`ml/sql/001_events.sql` mirrors
`supabase/migrations/20260909201144_events_append_only.sql`. Columns, types,
check constraint and indexes were diffed against a live Supabase database on
2025-07-18 and are identical.

Two things are deliberately dropped on the ml side: the **append-only trigger**
and the **revoked grants**. Append-only is a guarantee about production
history; the corpus is truncated and regenerated on every `make data`, so the
trigger would reject the truncate and the grants would lock out the writer.
Recorded in `docs/Design Decisions.md`.

**The shape is not relaxed.** A feature function written against this table has
to work unchanged against the production log, because in M14 it does. There is
no automated diff between the two schemas — the coupling is held by the header
comment in `001_events.sql`, by `PAYLOAD_KEYS` in `ml/src/ml/events.py`, and by
`ml/tests/test_contract.py`, which fails if a generated row stops matching.
