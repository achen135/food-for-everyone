-- M14 — `public.listing_risk`: the ML subsystem's batch output, read by the app.
--
-- This is the **only** table the `ml/` side ever writes in production, and the
-- only ml table the web app ever reads. Everything else in the subsystem lives
-- in its own Postgres (`docker-compose.yml`, port 55432) and never touches this
-- project. See `docs/ML Subsystem.md` §4 and `ml/src/ml/batch/writeback.py`.
--
-- ## Sync obligation — this table exists in two databases
--
-- The corpus has its own `listing_risk` in `ml/sql/002_ml_tables.sql`, and the
-- columns below must stay identical to it. The two are not the same *kind* of
-- file, which is the trap:
--
--   ml/sql/002_ml_tables.sql   bootstrap DDL. Re-applied from empty, freely
--                              edited, picked up by `make db-reset`.
--   this file                  an ordered migration. Production has run it;
--                              it is never edited again. A change is a new
--                              migration.
--
-- Same shape as `ml/sql/001_events.sql` mirroring the M10 events migration, and
-- held the same way: by this comment, by the batch job writing both through one
-- `RiskRow`, and by review. A drift between them does not fail loudly — it
-- writes a column the reader does not have.
--
-- ## Why one row per listing rather than an append log
--
-- The app asks "what is this listing's risk right now". The history of how that
-- answer moved is `predictions`, on the ml side, which the scoring path already
-- writes per score. Keeping current state here means the read is a primary-key
-- lookup with no window function and no "latest row per listing" subquery in
-- the request path.
--
-- The batch job deletes rows for listings that are no longer open, so an absent
-- row is the normal state for most listings and the reader treats it as "no
-- opinion" rather than as an error.

create table if not exists public.listing_risk (
  listing_id    uuid        primary key,
  risk_tier     text        not null check (risk_tier in ('low', 'medium', 'high')),
  score         double precision not null,
  model_version text        not null,
  scored_at     timestamptz not null default now()
);

create index if not exists listing_risk_tier_idx
  on public.listing_risk (risk_tier, scored_at desc);

-- No foreign key to `listings`, for the same reason `events` has none (M10,
-- Design Decisions 2026-09-09): every `on delete` action is wrong here.
-- `cascade` would let a listing deletion silently rewrite ml output, and
-- `restrict` would let a stale risk row block `db:seed --reset`, which deletes
-- and regenerates listings by design. The batch job's `prune` is what keeps
-- this table honest, and an orphan row is inert — nothing joins to it except a
-- lookup by a listing id the caller already holds.

------------------------------------------------------------------------------
-- Row Level Security — SELECT only, scoped to the caller's own listings.
--
-- **No insert/update/delete policy at all**, so RLS denies every write to
-- `anon` and `authenticated` outright. The batch job writes with the
-- service-role key, which is not subject to RLS. This follows the access model
-- established in M3 and extended in M4/M6: writes go through a path users
-- cannot reach, and the policy — not any application-side check — is the
-- boundary. The anon key ships to the browser and PostgREST is reachable
-- directly, so a guard in a Server Action or a loader is UX, never a fence.
--
-- ## Why "own listings" and not all-authenticated
--
-- The M14 brief allowed either. Scoped won because it costs nothing: the UI
-- surfaces risk as a *donor* nudge on the donor's own listings, so the policy
-- is exactly the query the product makes, and `listing_owned_by_me` already
-- exists (M6) and is `security definer`, so the subquery is a single indexed
-- lookup that RLS on `listings` cannot recurse into.
--
-- The consequence to know: if the UI ever surfaces risk to *recipients*
-- browsing open listings, this policy has to widen in a new migration. That is
-- the correct amount of friction for widening who can read a derived signal
-- about someone else's listing.
------------------------------------------------------------------------------
alter table public.listing_risk enable row level security;

drop policy if exists "listing_risk_select_own_listings" on public.listing_risk;
create policy "listing_risk_select_own_listings"
  on public.listing_risk for select
  to authenticated
  using (public.listing_owned_by_me(listing_id));

-- `revoke from public` alone is NOT enough on Supabase — anon and authenticated
-- hold direct grants that PUBLIC's revoke leaves in place (learned in M3). Name
-- anon explicitly. `authenticated` keeps SELECT, which RLS then narrows to the
-- policy above; it gets no write privilege of any kind.
revoke all on table public.listing_risk from public, anon;
grant select on table public.listing_risk to authenticated;
