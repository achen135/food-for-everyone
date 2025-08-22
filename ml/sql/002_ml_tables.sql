-- ml corpus bootstrap — the ml-side tables (docs/ML Subsystem.md §4).
--
-- All four are created empty here. M12 populates `features_waste`, M13
-- `predictions`, M14 `listing_risk` and `metric_history`.
--
-- ## These are bootstrap DDL, not migrations
--
-- `supabase/migrations/` is an ordered, append-only history: a file lands once
-- and is never edited, because production has already run it. `ml/sql/` is the
-- opposite — it is re-applied from empty every time, and the corpus it
-- describes is regenerated from a seed rather than accumulated. So a later
-- milestone that needs a different column **edits this file** rather than
-- adding a 003, and `make db-reset` picks the change up.
--
-- The one thing that must not be edited casually is 001_events.sql, which
-- mirrors a real migration and carries a sync obligation.
--
-- **As of M14 this file has a partial counterpart too.** `listing_risk` below
-- now also exists in production Supabase, created by
-- `supabase/migrations/20260910203000_listing_risk.sql`, because the web app
-- reads it. Its five columns must stay identical in both places — the batch job
-- writes both through one `RiskRow` (`ml/src/ml/batch/writeback.py`), so a
-- divergence shows up as a write of a column the other side does not have.
-- `features_waste`, `predictions` and `metric_history` have no web counterpart
-- and remain free to change.

------------------------------------------------------------------------------
-- features_waste — one row per open-listing observation.
--
-- The grain is (listing_id, as_of), not listing_id: a listing is observed at
-- post time and then hourly for as long as it stays open, so the same listing
-- contributes many rows with a widening `hours_since_posted` and a shrinking
-- `hours_to_pickup_end`. That is the shape M13 serves against — a listing is
-- re-scored on the hour, not once.
--
-- **Every column here is a pure function of events with `occurred_at <=
-- as_of`.** That is not a convention, it is the property M12's leakage guard
-- recomputes and asserts. `label` is the deliberate exception: it is derived
-- from the listing's eventual outcome and is the thing being predicted.
--
-- `split` is assigned by `as_of` on a strict time boundary, so no training row
-- is ever chronologically after a test row.
------------------------------------------------------------------------------
create table if not exists public.features_waste (
  listing_id                   uuid        not null,
  as_of                        timestamptz not null,

  -- Listing-intrinsic, all from the listing_posted payload.
  hours_to_pickup_end          double precision not null,
  hours_since_posted           double precision not null,
  lead_time_hours              double precision not null,
  pickup_window_hours          double precision not null,
  quantity_units               double precision,
  notes_length                 integer     not null,
  food_category                text,
  donor_verified               boolean     not null,
  donor_lat                    double precision not null,
  donor_lng                    double precision not null,
  posted_hour                  smallint    not null,
  posted_dow                   smallint    not null,
  as_of_hour                   smallint    not null,
  as_of_dow                    smallint    not null,
  -- The hour `pickup_end` falls in. Separate from its duration, and by far the
  -- sharpest single signal in the corpus: a window closing at 05:00 has almost
  -- no chance of being collected, because nobody is open to collect it.
  pickup_end_hour              smallint    not null,

  -- Donor track record, counted over that donor's prior listings only.
  donor_prior_listings         integer     not null,
  donor_prior_claim_rate       double precision,
  donor_prior_completion_rate  double precision,
  donor_prior_cancel_rate      double precision,
  donor_hours_since_last_post  double precision,
  -- Median hours from post to claim over this donor's previously claimed
  -- listings. Null until the donor has one.
  donor_median_claim_latency   double precision,

  -- Local market conditions as of the observation.
  recipients_within_5km        integer     not null,
  recipients_within_15km       integer     not null,
  open_listings_within_15km    integer     not null,
  claims_within_15km_prior_7d  integer     not null,

  -- The thing being predicted: 1 = reached pickup_end unclaimed.
  label                        smallint    not null check (label in (0, 1)),
  split                        text        not null check (split in ('train', 'val', 'test')),

  primary key (listing_id, as_of)
);

create index if not exists features_waste_as_of_idx
  on public.features_waste (as_of);

create index if not exists features_waste_split_idx
  on public.features_waste (split);

------------------------------------------------------------------------------
-- predictions — every score the serving path produced (M13).
--
-- `features_hash` is a digest of the exact feature vector the score was
-- computed from. It is what makes a served prediction reproducible after the
-- fact: re-derive the features for that listing at that instant, hash them,
-- and a mismatch means the serving path and the pipeline have diverged — the
-- failure mode that training/serving skew actually looks like in production.
------------------------------------------------------------------------------
create table if not exists public.predictions (
  id            bigint generated always as identity primary key,
  listing_id    uuid        not null,
  model_version text        not null,
  score         double precision not null,
  features_hash text        not null,
  served_at     timestamptz not null default now()
);

create index if not exists predictions_listing_idx
  on public.predictions (listing_id, served_at desc);

create index if not exists predictions_served_at_idx
  on public.predictions (served_at);

------------------------------------------------------------------------------
-- listing_risk — the current batch output, one row per listing (M14).
--
-- This is the only ml table the web app ever reads, behind a feature flag and
-- with a silent fallback. `listing_id` is the primary key rather than an
-- append log: the app wants "what is this listing's risk right now", and the
-- history of how that changed lives in `predictions`.
--
-- **Mirrored in production** by migration 20260910203000 — see the sync note in
-- this file's header. The production copy additionally carries RLS (select
-- scoped to the caller's own listings, no write policy at all); this one does
-- not, because the corpus database has no users to authorise.
------------------------------------------------------------------------------
create table if not exists public.listing_risk (
  listing_id    uuid        primary key,
  risk_tier     text        not null check (risk_tier in ('low', 'medium', 'high')),
  score         double precision not null,
  model_version text        not null,
  scored_at     timestamptz not null default now()
);

create index if not exists listing_risk_tier_idx
  on public.listing_risk (risk_tier, scored_at desc);

------------------------------------------------------------------------------
-- metric_history — nightly monitoring rows (M14).
--
-- `metrics` and `psi` are jsonb rather than columns because what gets measured
-- changes as the subsystem grows, and a monitoring table that needs a schema
-- change to record a new statistic tends to stop recording new statistics.
------------------------------------------------------------------------------
create table if not exists public.metric_history (
  id           bigint generated always as identity primary key,
  evaluated_at timestamptz not null default now(),
  model_version text,
  metrics      jsonb       not null default '{}'::jsonb,
  psi          jsonb       not null default '{}'::jsonb
);

create index if not exists metric_history_evaluated_at_idx
  on public.metric_history (evaluated_at desc);
