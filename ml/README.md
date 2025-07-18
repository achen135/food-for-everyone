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
make data      # start Postgres, install, generate ~309k events (~25 s)
make check     # ruff + mypy + pytest
```

`make data` is idempotent: it truncates `events` and regenerates from the seed,
so it always produces exactly the corpus documented in `docs/simulator.md`.

```
make help      # every target
make jsonl     # reference stream to out/events.jsonl
make hash      # stream sha256 — the determinism check
make psql      # a shell on the corpus database
make db-reset  # after editing ml/sql/
```

## Layout

```
ml/
├── pyproject.toml       package metadata, ruff + mypy + pytest config
├── Makefile             every task; `make help` lists them
├── Dockerfile           minimal now; the serving image in M13
├── sql/
│   ├── 001_events.sql   MIRRORS a real migration — see the sync obligation below
│   └── 002_ml_tables.sql features_waste, predictions, listing_risk, metric_history
├── src/ml/
│   ├── events.py        the payload contract, in code
│   ├── db.py            connection, bootstrap, truncate
│   └── simulate/        the generative model
│       ├── config.py    every tunable, all-constants-no-logic
│       ├── geo.py       Chicago-metro clusters, haversine
│       ├── orgs.py      latent traits (the documented cap)
│       ├── engine.py    the discrete-event behavioural model
│       ├── sink.py      JSONL and Postgres (COPY) outputs
│       └── rng.py       determinism plumbing
├── tests/               determinism, contract conformance, volume
└── docs/simulator.md    what the generator assumes, and what that costs
```

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
