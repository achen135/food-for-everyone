-- ml corpus bootstrap — `public.events`.
--
-- ## Source of truth, and the obligation that comes with it
--
-- This table is a COPY of the one created by
--
--     supabase/migrations/20260909201144_events_append_only.sql
--
-- and that migration is the source of truth. The columns, types, check
-- constraint, indexes and the per-type `payload` contract below must stay
-- byte-for-byte equivalent in meaning to it.
--
-- **Sync obligation.** If that migration ever changes — a sixth event type, a
-- new payload key, a widened column — this file changes in the same commit,
-- and so does the contract encoded in `ml/src/ml/events.py`, which is what the
-- conformance test actually checks. There is no automated diff between the two
-- schemas (the web side is Supabase-managed and this side is not), so the
-- coupling is held by this comment, that test, and review discipline. A drift
-- here does not fail loudly; it silently trains a model on a shape production
-- no longer emits.
--
-- ## Why this is not the same file
--
-- Two things from the migration are deliberately absent.
--
-- 1. **No append-only trigger, and no revoked grants.** Append-only is a
--    guarantee about *production history* — a claim that the log records what
--    actually happened and was never edited afterwards. It is meaningless for a
--    corpus that is generated, and actively in the way: `make data` truncates
--    and regenerates from a seed, which is the whole point of a deterministic
--    simulator. The trigger would reject the truncate, and the revoked grants
--    would lock out the ml role that has to write. Recorded in
--    docs/Design Decisions.md (2025-07-18).
--
-- 2. **No RLS, no Supabase roles.** There is no `anon`, no `authenticated` and
--    no PostgREST in front of this database. It is a single-tenant analytics
--    store reached only by the ml service.
--
-- What is NOT relaxed is the shape. Every column, every type, every index is
-- the migration's. A feature function written against this table has to work
-- unchanged against the production log, because in M14 it does.

create table if not exists public.events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  event_type     text not null check (event_type in (
                   'listing_posted',
                   'listing_claimed',
                   'claim_completed',
                   'claim_cancelled',
                   'listing_cancelled'
                 )),
  listing_id     uuid,
  claim_id       uuid,
  actor_org_id   uuid,
  payload        jsonb not null default '{}'::jsonb,
  schema_version smallint not null default 1
);

-- The ml side's cursor: "everything since (t, id)", stable across ties.
create index if not exists events_occurred_at_idx
  on public.events (occurred_at, id);

create index if not exists events_event_type_idx
  on public.events (event_type);

create index if not exists events_listing_idx
  on public.events (listing_id)
  where listing_id is not null;

-- Partial: only two of the five types carry a claim, so most rows are null and
-- the only useful lookup is by a real claim id.
create index if not exists events_claim_idx
  on public.events (claim_id)
  where claim_id is not null;

------------------------------------------------------------------------------
-- The payload contract, per event type. Reproduced from the migration so this
-- file stands alone; enforced in code by `ml.events.PAYLOAD_KEYS`.
--
--   listing_posted     actor = donor
--                      donor_org_id, donor_lat, donor_lng, donor_verified,
--                      title, quantity, notes_length,
--                      pickup_start, pickup_end
--
--   listing_claimed    actor = recipient
--                      donor_org_id, donor_lat, donor_lng, donor_verified,
--                      recipient_org_id, recipient_lat, recipient_lng,
--                      distance_km, pickup_start, pickup_end
--
--   claim_completed    actor = donor
--                      donor_org_id, recipient_org_id, pickup_end, claimed_at
--
--   claim_cancelled    actor = recipient
--                      donor_org_id, recipient_org_id, pickup_end, claimed_at,
--                      cancelled_by = 'recipient'
--
--   listing_cancelled  actor = donor
--                      donor_org_id, pickup_end, cancelled_by = 'donor',
--                      displaced_claim_id, displaced_recipient_org_id,
--                      displaced_claimed_at  (all null if it was unclaimed)
--
-- `pickup_end` is on every type because it is the label-critical field.
-- `notes_length`, never the notes text.
-- There is still no `listing_expired`: expiry is derived by the pipeline from
-- `payload.pickup_end` and the absence of a `listing_claimed`.
------------------------------------------------------------------------------
