-- M14 — make `backfill_events()` incremental instead of all-or-nothing.
--
-- ## The bug this fixes, and why it only surfaced now
--
-- M10 shipped `backfill_events()` with this guard:
--
--     if exists (select 1 from public.events where payload->>'backfilled' = 'true')
--     then return 0; end if;
--
-- That is a **table-level** check: once any backfilled row exists, the function
-- refuses to do anything ever again. It was exactly right for what M10 needed —
-- a one-time pass that must not double-count if re-run — and it is wrong for
-- the operation this project actually performs on a schedule.
--
-- `npm run db:seed -- --reset-activity` deletes and regenerates the seeded
-- listings and claims. It is the documented, sanctioned way to refresh the demo
-- data, and it has to be re-run periodically because the seed builds its live
-- window *relative to `now`* — the window slides, so a database seeded a week
-- ago has no open listings left. (Measured on 2026-09-10: 259 listings, 67 with
-- `status = 'open'`, and every single `pickup_end` in the past.)
--
-- After such a re-seed the event log describes listings that no longer exist,
-- and the new listings have no events at all — because the seed writes rows
-- directly rather than through the transition functions, and because the guard
-- above then refuses to fill them in. M14's batch scorer reads the event log,
-- so it would find zero open listings and write an empty `listing_risk`, with
-- nothing anywhere reporting a problem.
--
-- ## What changes
--
-- The guard moves from the table to the **listing**: a listing is skipped if it
-- already has a `listing_posted` event, and filled in otherwise. Re-running is
-- still safe — that is the property M10 wanted and it is preserved — but a
-- listing that appeared since the last pass now gets its history.
--
-- ## Append-only is respected, not worked around
--
-- Everything here is an INSERT. The append-only triggers on `public.events`
-- (M10) block UPDATE, DELETE and TRUNCATE, and this migration does not disable
-- them, because it never needs to: events for deleted listings simply remain in
-- the log. That is the correct outcome for an append-only history — those
-- events *did* happen, in the demo's own terms, and the ml side reads them as
-- prior donor track record. Nothing joins events to listings (there are no
-- foreign keys, on purpose), so an event whose listing has been deleted is
-- inert rather than dangling.
--
-- The reconstruction logic below is M10's, unchanged, minus the CTEs that only
-- made sense for a whole-table pass. The timestamp-recovery rules and the
-- two-second seam for telling a recipient release from a donor withdrawal are
-- documented in `20260909201145_events_backfill.sql` and still apply.

create or replace function public.backfill_events_incremental()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_inserted bigint;
begin
  with pending as (
    -- The whole change is here: per-listing, not per-table.
    select l.id
    from public.listings l
    where not exists (
      select 1 from public.events e
      where e.listing_id = l.id and e.event_type = 'listing_posted'
    )
  ),

  cancel_release as (
    select distinct on (c.listing_id)
      c.id              as claim_id,
      c.listing_id      as listing_id,
      c.organization_id as recipient_org_id,
      c.created_at      as claimed_at
    from public.claims c
    join public.listings l on l.id = c.listing_id
    join pending p on p.id = l.id
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
    join pending p on p.id = l.id
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
    join pending p on p.id = l.id
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
    join pending p on p.id = l.id
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
    join pending p on p.id = l.id
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
    join pending p on p.id = l.id
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
  -- Identity ids are assigned in insertion order, and `(occurred_at, id)` is
  -- the forward cursor the ml side replays on — so this ORDER BY *is* the
  -- causal order of the log, not a cosmetic detail.
  --
  -- M10 ordered by `occurred_at, event_type`, which is alphabetical, and that
  -- is wrong whenever two events of a listing share an instant: 'claim_cancelled'
  -- sorts before 'listing_claimed', so a claim created and released at the same
  -- timestamp — which the seed does produce — lands in the log as
  -- released-then-claimed. Replaying that leaves the listing `claimed` when it
  -- is really back `open`, and M14's batch scorer then skips a listing it
  -- should have scored. Measured on a freshly seeded local database: 1 such
  -- collision in 693 events, and it cost exactly one open listing.
  --
  -- Ordering by causal rank instead. Within one instant: a listing is posted
  -- before it is claimed, and claimed before that claim ends.
  order by
    occurred_at,
    case event_type
      when 'listing_posted'    then 0
      when 'listing_claimed'   then 1
      when 'claim_completed'   then 2
      when 'claim_cancelled'   then 3
      when 'listing_cancelled' then 4
    end;
  -- Residual ambiguity, stated rather than hidden: if a recipient released a
  -- claim and another claimed the same listing **in the same microsecond**,
  -- this orders the new claim before the old release and the listing reads
  -- `open` when it should read `claimed` — the mirror of the bug above. That
  -- pattern does not occur in the seeded data (0 of 693 collisions involved two
  -- different claims), and no ordering of a single timestamp column can resolve
  -- it; distinguishing them needs an ordering key the source rows do not carry.

  get diagnostics v_inserted = row_count;
  raise notice 'incremental events backfill: inserted % rows', v_inserted;
  return v_inserted;
end $$;

revoke all on function public.backfill_events_incremental() from public, anon, authenticated;

-- Not called here. M10's one-time pass has already run on production, and this
-- migration only installs the function; the seed script calls it after writing
-- activity (`npm run db:seed -- --reset-activity`). A migration that also ran
-- it would make `supabase db reset` order-dependent — at that point in a reset
-- the tables are empty and it would insert nothing, which is harmless but
-- misleading to read.
