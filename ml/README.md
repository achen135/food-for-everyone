# `ml/` — Food For Everyone ML subsystem

An additive subsystem inside the FFE repo. The web app (TypeScript, repo root)
writes an append-only `events` log; this package reads only that log and never
touches FFE's mutable tables.

**One model, end to end.** For an open donation listing, predict _will this
expire unclaimed?_ — scored at post time and re-scored hourly, so the app can
surface at-risk listings before the food is lost. Plan and rationale:
`docs/ML Subsystem.md`.

> Everything in the corpus is **simulated**. FFE has no real traffic. No figure
> from here is ever described as real (Spec §9), and what the generator assumes
> — which bounds what any metric can claim — is written down in
> [`docs/simulator.md`](docs/simulator.md).

## Status

| Milestone |                                                                  |                      |
| --------- | ---------------------------------------------------------------- | -------------------- |
| M11       | Simulator — seeded generative model writing `events`-schema rows | ✅                   |
| M12       | Feature pipeline + rules baselines + eval harness                | ✅                   |
| M13       | LightGBM model + FastAPI serving                                 | model ✅ / serving — |
| M14       | Batch scoring, write-back, drift monitoring                      | —                    |

## Quick start

Needs Python 3.12+ and Docker (for the corpus Postgres).

```bash
cd ml
make reproduce # data -> features -> baselines -> model, from nothing (~2 min)
make check     # ruff + mypy + pytest
```

`make reproduce` is `make data && make features && make eval-baselines && make
model`, and it regenerates both `baselines.json` and everything in `model/`
**byte-identically** from an empty database. Each step is idempotent: `data`
truncates `events` and replays the seed, `features` truncates `features_waste`
and recomputes it, `model` retrains and overwrites the bundle.

On macOS LightGBM's wheel needs OpenMP from outside pip — `brew install libomp`
— or `import lightgbm` fails with a `libomp.dylib` load error.

```
make help      # every target
make data      # ~309k events into Postgres
make features  # ~438k point-in-time observations into features_waste
make eval-baselines   # rewrite baselines.json
make model     # train Model A, rewrite model/ (~75 s)
make jsonl     # reference event stream to out/events.jsonl
make hash      # stream sha256 — the determinism check
make psql      # a shell on the corpus database
make db-reset  # after editing ml/sql/
make test-pg   # tests that need the corpus database
make test-slow # tests including the full-scale volume run
```

## What the numbers currently are

Committed in [`baselines.json`](baselines.json), on the default seed. **Simulated
data** — see [`docs/simulator.md`](docs/simulator.md) for what the generator
assumes and therefore what these can and cannot mean.

|        | events  | listings | observations     |
| ------ | ------- | -------- | ---------------- |
| corpus | 309,069 | 113,149  | 438,093 labelled |

| baseline                | test PR-AUC | test ROC-AUC | lift over base |
| ----------------------- | ----------- | ------------ | -------------- |
| hours to `pickup_end`   | 0.766       | 0.790        | 1.68x          |
| recipients within 15 km | 0.636       | 0.671        | 1.39x          |

Base rate 0.457, so PR-AUC is always quoted beside it. That base rate is
**per observation, not per listing**: 24.8% of listings are wasted, but wasted
listings stay open longer and so contribute more hourly observations. Both
numbers are real and they answer different questions — see Design Decisions.

Those test numbers were computed once, in M12, before any model existed, which
is what stops the bar moving later; `k` was chosen on validation only.

**Model A (M13) clears both**, on the same untouched test split and through the
same eval harness:

|                                    | test PR-AUC | test ROC-AUC | test Brier |
| ---------------------------------- | ----------- | ------------ | ---------- |
| hours to `pickup_end` (baseline)   | 0.7660      | 0.7900       | —          |
| recipients within 15 km (baseline) | 0.6356      | 0.6713       | —          |
| **Model A**                        | **0.9715**  | **0.9755**   | **0.0630** |

Margins: **+0.2054** PR-AUC over time-pressure (+26.8%) and
**+0.3358** over recipient-scarcity (+52.8%). The stated goal — catch

> = 80% of doomed listings at <= 25% false-alarm rate — is met at the threshold
> chosen on `val_op`: recall **0.8353** at a **0.0430** false-alarm rate,
> precision **0.9423**. Train-to-test PR-AUC gap is
> +0.0049, so this is not overfitting.

**Read the margin with the caveat attached.** Most of it comes from one feature,
`pickup_end_hour` (31.2% of mean|SHAP|): the simulator decides collection
substantially by whether the pickup window closes while recipients are open, so
the model is largely recovering the generator's own rule. On real data that rule
would be softer and the margin smaller. `model/model_card.json` states this and
five other limitations.

## Layout

```
ml/
├── pyproject.toml       package metadata, ruff + mypy + pytest config
├── Makefile             every task; `make help` lists them
├── Dockerfile           minimal now; the serving image in M13
├── sql/
│   ├── 001_events.sql   MIRRORS a real migration — see the sync obligation below
│   └── 002_ml_tables.sql features_waste, predictions, listing_risk, metric_history
├── baselines.json       the committed bar M13 had to beat
├── model/               the committed Model A bundle                  [M13]
│   ├── model_a.txt      the booster, LightGBM text format
│   ├── model_a.json     feature order, isotonic knots, tier thresholds
│   ├── model_card.json  params, search, metrics, goal check, limitations
│   └── shap_summary.json  mean|SHAP| per feature
├── src/ml/
│   ├── events.py        the payload contract, in code
│   ├── db.py            connection, bootstrap, truncate
│   ├── simulate/        the generative model                          [M11]
│   │   ├── config.py    every tunable, all-constants-no-logic
│   │   ├── geo.py       Chicago-metro clusters, haversine
│   │   ├── orgs.py      latent traits (the documented cap)
│   │   ├── engine.py    the discrete-event behavioural model
│   │   ├── sink.py      JSONL and Postgres (COPY) outputs
│   │   └── rng.py       determinism plumbing
│   ├── features/        point-in-time features and the label          [M12]
│   │   ├── spec.py      the feature contract: names, types, radii
│   │   ├── reference.py the SPECIFICATION — slow, obvious, filtered once
│   │   ├── pipeline.py  the streaming forward pass that actually runs
│   │   ├── geo_index.py incremental spatial counters
│   │   ├── labels.py    the derived label, in its own pass
│   │   ├── text.py      quantity and category from free text
│   │   └── writer.py    features_waste in and out
│   ├── baselines/       the two rules baselines                       [M12]
│   ├── eval/            splits, metrics, harness                      [M12]
│   ├── corpus.py        the corpus fingerprint both committed files carry
│   └── model/           Model A: train, calibrate, explain, card      [M13]
│       ├── dataset.py   design matrix; cutting val into fit / op
│       ├── search.py    the 18-point grid, scored on val_fit only
│       ├── calibrate.py isotonic + the two tier boundaries
│       ├── explain.py   TreeSHAP via LightGBM, no `shap` dependency
│       ├── artifact.py  the committed bundle, in and out
│       └── card.py      the model card, and what it must not contain
├── tests/               determinism, contract, volume, LEAKAGE, splits, model
└── docs/simulator.md    what the generator assumes, and what that costs
```

## The leakage guard

`tests/test_leakage.py` is the correctness check this milestone is built around.
A leaked feature does not crash — it produces a model that scores beautifully
offline and collapses in production. So there are two implementations of the
feature computation, sharing no code below `spec.py`:

- `reference.py` filters the log to `occurred_at <= as_of` at the top of one
  function, and is otherwise as obvious as possible. It is the specification.
- `pipeline.py` walks the log forward holding incremental state, and cannot
  express the leak: events after `as_of` have not been read yet.

The guard asserts they agree, that the reference produces identical values from
the whole log and from a prefix of it, and that re-running the pipeline over a
truncated log reproduces the rows it already emitted. It found all three of the
real bugs in this milestone.

The import package is `ml` under `src/`, so `python -m ml.simulate` works and a
stray `import ml` cannot silently resolve against the source tree instead of
the installed package.

## The database is not FFE's

The corpus lives in its own Postgres on **port 55432** (`docker-compose.yml` at
the repo root). Not 5432, which collides with a system Postgres, and not 54322,
which is local Supabase — a different database holding the product's own data,
frequently up at the same time.

That separation is load-bearing. The corpus is truncated and regenerated on
every `make data`; the production log is append-only and enforces it with a
trigger. `ml/src/ml/db.py` refuses a DSN that looks like Supabase for exactly
this reason.

## Sync obligation

`sql/001_events.sql` is a copy of
`supabase/migrations/20260909201144_events_append_only.sql`, which is the source
of truth. **If that migration changes, this file and `src/ml/events.py` change
in the same commit.** There is no automated diff between the two schemas — the
web side is Supabase-managed and this side is not — so the coupling is held by
`tests/test_contract.py` and by review. Drift here does not fail loudly; it
quietly trains a model on a shape production no longer emits.

## Conventions

Same as the rest of the repo: one branch per milestone, `main` green, never
squash-merge (commits carry deliberate author dates), and every milestone
updates `docs/Sessions.md`, `docs/Architecture.md` and `docs/Concepts.md`.
