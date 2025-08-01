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

| Milestone |                                                                  |     |
| --------- | ---------------------------------------------------------------- | --- |
| M11       | Simulator — seeded generative model writing `events`-schema rows | ✅  |
| M12       | Feature pipeline + rules baselines + eval harness                | —   |
| M13       | LightGBM model + FastAPI serving                                 | —   |
| M14       | Batch scoring, write-back, drift monitoring                      | —   |

## Quick start

Needs Python 3.12+ and Docker (for the corpus Postgres).

```bash
cd ml
make reproduce # data -> features -> baselines, from nothing (~25 s total)
make check     # ruff + mypy + pytest
```

`make reproduce` is `make data && make features && make eval-baselines`, and it
regenerates `baselines.json` **byte-identically** from an empty database. Each
step is idempotent: `data` truncates `events` and replays the seed, `features`
truncates `features_waste` and recomputes it.

```
make help      # every target
make data      # ~309k events into Postgres
make features  # ~438k point-in-time observations into features_waste
make eval-baselines   # rewrite baselines.json
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

M13's model has to beat both of these on the untouched test split. Those test
numbers were computed once, here, before any model existed, which is what stops
the bar moving later; `k` was chosen on validation only.

## Layout

```
ml/
├── pyproject.toml       package metadata, ruff + mypy + pytest config
├── Makefile             every task; `make help` lists them
├── Dockerfile           minimal now; the serving image in M13
├── sql/
│   ├── 001_events.sql   MIRRORS a real migration — see the sync obligation below
│   └── 002_ml_tables.sql features_waste, predictions, listing_risk, metric_history
├── baselines.json       the committed bar M13 has to beat
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
│   └── eval/            splits, metrics, harness                      [M12]
├── tests/               determinism, contract, volume, LEAKAGE, splits
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
