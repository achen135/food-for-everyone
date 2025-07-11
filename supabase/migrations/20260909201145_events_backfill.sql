-- M10 — one-time backfill: synthesise events for the listings and claims that
-- already exist.
--
-- Separate file from the schema on purpose. This one writes data, runs once,
-- and is the only part of M10 that can be wrong in a way a migration cannot
-- fix afterwards — `events` is append-only, so a bad backfill is corrected by
-- appending, never by editing. Keeping it apart means the schema can be
-- re-applied on a fresh `db reset` without dragging a data pass along with it.
--
-- ## What the timestamps can and cannot be
--
-- Two of the four are exact. `listings.created_at` is when a listing was
-- posted; `claims.created_at` is when it was claimed. The rest are recovered:
--
--   claim_completed    coalesce(claims.released_at, listings.updated_at)
--                      -- complete_listing sets released_at in the same
--                      -- transaction it flips the listing, so these agree.
--   claim_cancelled    coalesce(claims.released_at, claims.created_at)
--   listing_cancelled  listings.updated_at
--                      -- `cancelled` is terminal: no write function will
--                      -- touch the row again, so the last update *is* the
--                      -- cancellation.
--
-- Every row is stamped `payload->>'backfilled' = 'true'`, so the ml side can
-- weight, exclude, or simply distinguish reconstructed history from what was
-- observed live.
--
-- ## The one genuinely ambiguous case
--
-- `claims.status = 'released'` has two possible causes and the schema does not
-- record which: the recipient handed it back (`release_claim`), or the donor
-- withdrew the listing and the claim was released as a side effect
-- (`cancel_listing`). Live, these are now two different event types. In the
-- history they are one column value.
--
-- The seam used here: a released claim is attributed to a donor withdrawal when
-- its listing ended up `cancelled` *and* the release landed within two seconds
-- of the listing's last update — which is what happens when one transaction did
-- both. Everything else is read as a recipient release. Two seconds is far
-- wider than the microseconds a single transaction actually spans, and narrower
-- than any plausible gap between a recipient releasing and a donor later
-- withdrawing. It will still be wrong for a listing withdrawn in the same
-- couple of seconds as an unrelated release; that is accepted, and it is why
-- these rows are marked.

create or replace function public.backfill_events()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_inserted bigint;
begin
  if exists (
    select 1 from public.events where payload ->> 'backfilled' = 'true'
  ) then
    raise notice 'events backfill: already applied, skipping';
    return 0;
  end if;

  with cancel_release as (
    -- At most one displaced claim per withdrawn listing. A listing can carry
    -- many released claims over its life (the partial unique index constrains
    -- only *active* ones), so take the latest release inside the window.
    select distinct on (c.listing_id)
      c.id              as claim_id,
      c.listing_id      as listing_id,
      c.organization_id as recipient_org_id,
      c.created_at      as claimed_at
    from public.claims c
    join public.listings l on l.id = c.listing_id
    where c.status = 'released'
      and l.status = 'cancelled'
      and c.released_at is not null
      and c.released_at between l.updated_at - interval '2 seconds'
                            and l.updated_at + interval '2 seconds'
    order by c.listing_id, c.released_at desc
  ),

  posted as (
    select
      l.created_at            as occurred_at,
      'listing_posted'        as event_type,
      l.id                    as listing_id,
      null::uuid              as claim_id,
      l.organization_id       as actor_org_id,
      jsonb_build_object(
        'donor_org_id',   l.organization_id,
        'donor_lat',      extensions.st_y(d.location::extensions.geometry),
        'donor_lng',      extensions.st_x(d.location::extensions.geometry),
        'donor_verified', d.verified,
        'title',          l.title,
        'quantity',       l.quantity,
        'notes_length',   coalesce(char_length(l.notes), 0),
        'pickup_start',   l.pickup_start,
        'pickup_end',     l.pickup_end
      )                       as payload
    from public.listings l
    left join public.organizations d on d.id = l.organization_id
  ),

  claimed as (
    select
      c.created_at,
      'listing_claimed',
      c.listing_id,
      c.id,
      c.organization_id,
      jsonb_build_object(
        'donor_org_id',     l.organization_id,
        'donor_lat',        extensions.st_y(d.location::extensions.geometry),
        'donor_lng',        extensions.st_x(d.location::extensions.geometry),
        'donor_verified',   d.verified,
        'recipient_org_id', c.organization_id,
        'recipient_lat',    extensions.st_y(r.location::extensions.geometry),
        'recipient_lng',    extensions.st_x(r.location::extensions.geometry),
        'distance_km',      extensions.st_distance(d.location, r.location) / 1000.0,
        'pickup_start',     l.pickup_start,
        'pickup_end',       l.pickup_end
      )
    from public.claims c
    join public.listings l on l.id = c.listing_id
    left join public.organizations d on d.id = l.organization_id
    left join public.organizations r on r.id = c.organization_id
  ),

  completed as (
    select
      coalesce(c.released_at, l.updated_at, c.created_at),
      'claim_completed',
      c.listing_id,
      c.id,
      l.organization_id,
      jsonb_build_object(
        'donor_org_id',     l.organization_id,
        'recipient_org_id', c.organization_id,
        'pickup_end',       l.pickup_end,
        'claimed_at',       c.created_at
      )
    from public.claims c
    join public.listings l on l.id = c.listing_id
    where c.status = 'completed'
  ),

  released_by_recipient as (
    select
      coalesce(c.released_at, c.created_at),
      'claim_cancelled',
      c.listing_id,
      c.id,
      c.organization_id,
      jsonb_build_object(
        'donor_org_id',     l.organization_id,
        'recipient_org_id', c.organization_id,
        'pickup_end',       l.pickup_end,
        'claimed_at',       c.created_at,
        'cancelled_by',     'recipient'
      )
    from public.claims c
    join public.listings l on l.id = c.listing_id
    where c.status = 'released'
      and not exists (
        select 1 from cancel_release cr where cr.claim_id = c.id
      )
  ),

  withdrawn as (
    select
      l.updated_at,
      'listing_cancelled',
      l.id,
      cr.claim_id,
      l.organization_id,
      jsonb_build_object(
        'donor_org_id',               l.organization_id,
        'pickup_end',                 l.pickup_end,
        'cancelled_by',               'donor',
        'displaced_claim_id',         cr.claim_id,
        'displaced_recipient_org_id', cr.recipient_org_id,
        'displaced_claimed_at',       cr.claimed_at
      )
    from public.listings l
    left join cancel_release cr on cr.listing_id = l.id
    where l.status = 'cancelled'
  ),

  all_events as (
    select * from posted
    union all select * from claimed
    union all select * from completed
    union all select * from released_by_recipient
    union all select * from withdrawn
  )

  insert into public.events (
    occurred_at, event_type, listing_id, claim_id, actor_org_id, payload
  )
  select
    occurred_at, event_type, listing_id, claim_id, actor_org_id,
    payload || jsonb_build_object('backfilled', 'true')
  from all_events
  -- Identity ids are assigned in insertion order, so ordering here makes
  -- (occurred_at, id) a clean forward cursor for the ml side from row one.
  order by occurred_at, event_type;

  get diagnostics v_inserted = row_count;
  raise notice 'events backfill: inserted % rows', v_inserted;
  return v_inserted;
end $$;

revoke all on function public.backfill_events() from public, anon, authenticated;

-- Run it. On production this is the one-time pass over the existing 259
-- listings / 211 claims. On a fresh `db reset` the tables are still empty here
-- and it inserts nothing, which is why it is a function and not an inline
-- block: `supabase/seed` writes listings and claims *directly* rather than
-- through the transition functions, so seeded activity emits no events, and the
-- only way to get it into the log locally is to call this again afterwards.
--
--   npm run db:reset:local
--   npm run db:seed:local
--   npm run db:test:events      -- calls backfill_events() and reconciles
--
-- The guard makes that safe: the function is idempotent on the marker, so it
-- fills whatever is there the first time it finds an empty log and refuses to
-- double up.
select public.backfill_events();
