-- M8 — analytics aggregates.
--
-- Five read functions behind the dashboard. Same shape as M3 and M6: reads that
-- need to see beyond the caller's own rows go through a `security definer`
-- function with an explicit return shape, never through a widened RLS policy.
-- Nothing here adds a policy, so the base tables stay exactly as locked as they
-- were.
--
-- ## Why aggregate in SQL rather than in the page
--
-- The alternative is selecting the rows and reducing them in TypeScript. It
-- would not work, for a reason that has nothing to do with speed: RLS would
-- hand the caller only the rows they are allowed to see, so a "network"
-- number computed in JavaScript would silently be a per-caller number — a
-- recipient's total would count open listings and their own claims and nothing
-- else. Aggregating in a definer function is what makes a network-wide figure
-- mean the same thing for everyone who reads it.
--
-- ## What is global and what is scoped — decided per metric
--
--   GLOBAL (safe to publish to any signed-in caller). Counts and rates only:
--   no organization is named, no coordinate is returned, and nothing here is
--   finer-grained than the counterparty directory the map already shows.
--     · network_overview        — how big the network is, and how busy
--     · network_activity_daily  — posted / completed per day
--     · network_reach           — how far food travels, as a histogram
--
--   SCOPED to the caller's organization, derived from auth.uid() and never from
--   an argument. Fulfilment is a judgement about a specific organization's
--   follow-through; publishing one org's to another would be a new disclosure
--   the product never promised.
--     · my_activity_summary
--     · my_activity_daily
--
-- ## Dates are bucketed in UTC
--
-- Deliberate, and it is a real trade-off: a viewer late in the evening in
-- Chicago sees a bucket labelled with tomorrow's date. The alternative is a
-- caller-supplied timezone, which means either trusting an argument (and
-- getting a different answer per caller for a "network" number) or a client
-- round-trip before the first paint. UTC is one answer for everybody and the
-- axis says so.

------------------------------------------------------------------------------
-- Indexes for the two scans these functions add. Both tables are small today;
-- these exist so the aggregates stay index-backed as history accumulates,
-- which is the whole point of keeping claims after they are released.
------------------------------------------------------------------------------
create index if not exists listings_created_at_idx
  on public.listings (created_at desc);

create index if not exists claims_completed_idx
  on public.claims (released_at)
  where status = 'completed';

------------------------------------------------------------------------------
-- network_overview() — the KPI tiles.
--
-- `open_listings` counts what a recipient could actually claim right now, so it
-- excludes windows that have already closed. That is the same derived-expiry
-- rule as everywhere else: expiry is a fact about the clock, never a stored
-- status (M6 migration header).
------------------------------------------------------------------------------
create or replace function public.network_overview()
returns table (
  donor_orgs         integer,
  recipient_orgs     integer,
  total_listings     integer,
  open_listings      integer,
  claimed_listings   integer,
  completed_listings integer,
  active_claims      integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*) from public.organizations o where o.type = 'donor')::integer,
    (select count(*) from public.organizations o where o.type = 'recipient')::integer,
    (select count(*) from public.listings)::integer,
    (select count(*) from public.listings l
      where l.status = 'open' and l.pickup_end > pg_catalog.now())::integer,
    (select count(*) from public.listings l where l.status = 'claimed')::integer,
    (select count(*) from public.listings l where l.status = 'completed')::integer,
    (select count(*) from public.claims c where c.status = 'active')::integer;
$$;

------------------------------------------------------------------------------
-- network_activity_daily(days) — the headline time series.
--
-- Gap-filled from a generated calendar. A chart built from `group by date`
-- alone silently omits days with no activity, and a line drawn straight across
-- the gap reads as steady trade on days when nothing happened at all.
--
-- The two series come from different tables on purpose:
--   · posted    — `listings.created_at`, when the food was offered.
--   · completed — `claims.released_at` for claims in status `completed`, which
--     is the instant `complete_listing` recorded the handover. Using
--     `listings.updated_at` instead would date the donation to whenever the row
--     was last touched for any reason.
------------------------------------------------------------------------------
create or replace function public.network_activity_daily(p_days integer default 90)
returns table (
  day       date,
  posted    integer,
  completed integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      least(greatest(coalesce(p_days, 90), 1), 365) as days,
      (pg_catalog.now() at time zone 'UTC')::date    as today
  ),
  calendar as (
    select d::date as day
    from bounds b,
      pg_catalog.generate_series(
        b.today - (b.days - 1),
        b.today,
        interval '1 day'
      ) as d
  ),
  posted as (
    select (l.created_at at time zone 'UTC')::date as day, count(*) as n
    from public.listings l, bounds b
    where (l.created_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  ),
  finished as (
    select (c.released_at at time zone 'UTC')::date as day, count(*) as n
    from public.claims c, bounds b
    where c.status = 'completed'
      and c.released_at is not null
      and (c.released_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  )
  select
    cal.day,
    coalesce(p.n, 0)::integer,
    coalesce(f.n, 0)::integer
  from calendar cal
  left join posted   p on p.day = cal.day
  left join finished f on f.day = cal.day
  order by cal.day;
$$;

------------------------------------------------------------------------------
-- network_reach() — "geographic spread", as a distance histogram.
--
-- Spec §9 asks for geographic spread. The obvious reading is a map of activity,
-- and that is the one thing this must not be: the map is deliberately scoped to
-- counterparties (a donor never sees other donors' locations — see Design
-- Decisions, auth-gated map), and plotting completed donations would hand every
-- signed-in user both sides of the directory.
--
-- The distance between the two organizations in a completed donation carries
-- the interesting part of that question — how far surplus food actually travels
-- — and none of the disclosure: a bucket count identifies nobody and no point.
--
-- Buckets are listed rather than derived so empty ones still appear; a
-- histogram that drops its empty bars changes shape as data arrives.
------------------------------------------------------------------------------
create or replace function public.network_reach()
returns table (
  bucket       text,
  bucket_order integer,
  donations    integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with bands (bucket, bucket_order, min_km, max_km) as (
    values
      ('Under 5 km',  1, 0::double precision,  5::double precision),
      ('5–10 km',     2, 5::double precision,  10::double precision),
      ('10–25 km',    3, 10::double precision, 25::double precision),
      ('25–50 km',    4, 25::double precision, 50::double precision),
      ('50 km+',      5, 50::double precision, 1e9::double precision)
  ),
  completed as (
    select
      extensions.st_distance(donor.location, recipient.location) / 1000.0 as km
    from public.claims c
    join public.listings l      on l.id = c.listing_id
    join public.organizations donor     on donor.id = l.organization_id
    join public.organizations recipient on recipient.id = c.organization_id
    where c.status = 'completed'
      and donor.location is not null
      and recipient.location is not null
  )
  select
    b.bucket,
    b.bucket_order,
    (select count(*) from completed d
      where d.km >= b.min_km and d.km < b.max_km)::integer
  from bands b
  order by b.bucket_order;
$$;

------------------------------------------------------------------------------
-- my_activity_summary() — the caller's own organization.
--
-- Returns no rows when the caller has no organization, which is the same signal
-- the rest of the app uses to show its "set up your organization" state.
--
-- Both the listing columns and the claim columns are returned even though one
-- side is normally empty: `create_listing` requires a donor and `claim_listing`
-- a recipient, so an organization accumulates one kind or the other. That is a
-- property of today's writes, not an invariant — `organizations.type` is
-- editable — so the function reports both rather than assuming.
--
-- ## fulfilment_rate, and why the fraction comes with it
--
-- "83%" out of context is a number the reader has to trust. `83% — 166 of 200`
-- is a number they can check, and it makes a rate computed from four finished
-- listings visibly weak rather than impressively high. Both parts are returned
-- so the UI never has to reconstruct the denominator.
--
-- The denominator is *finished* work, not everything ever posted — a listing
-- still open today has not failed, it just has not resolved. For a donor that
-- means completed + cancelled + expired; for a recipient, claims that were
-- collected + claims they released. `null` when nothing has finished, which the
-- UI renders as "not enough history yet" rather than as 0%.
------------------------------------------------------------------------------
create or replace function public.my_activity_summary()
returns table (
  role                   public.organization_type,
  listings_posted        integer,
  listings_open          integer,
  listings_expired       integer,
  listings_claimed       integer,
  listings_completed     integer,
  listings_cancelled     integer,
  claims_made            integer,
  claims_active          integer,
  claims_completed       integer,
  claims_released        integer,
  fulfilment_numerator   integer,
  fulfilment_denominator integer,
  fulfilment_rate        numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select o.id, o.type
    from public.organizations o
    where o.owner_id = (select auth.uid())
    limit 1
  ),
  l as (
    select
      count(*)::integer as posted,
      count(*) filter (
        where listings.status = 'open' and listings.pickup_end > pg_catalog.now()
      )::integer as still_open,
      count(*) filter (
        where listings.status = 'open' and listings.pickup_end <= pg_catalog.now()
      )::integer as expired,
      count(*) filter (where listings.status = 'claimed')::integer   as claimed,
      count(*) filter (where listings.status = 'completed')::integer as completed,
      count(*) filter (where listings.status = 'cancelled')::integer as cancelled
    from public.listings, me
    where listings.organization_id = me.id
  ),
  c as (
    select
      count(*)::integer as made,
      count(*) filter (where claims.status = 'active')::integer    as active,
      count(*) filter (where claims.status = 'completed')::integer as completed,
      count(*) filter (where claims.status = 'released')::integer  as released
    from public.claims, me
    where claims.organization_id = me.id
  ),
  rate as (
    select
      case me.type
        when 'donor' then l.completed
        else c.completed
      end as numerator,
      case me.type
        when 'donor' then l.completed + l.cancelled + l.expired
        else c.completed + c.released
      end as denominator
    from me, l, c
  )
  select
    me.type,
    l.posted, l.still_open, l.expired, l.claimed, l.completed, l.cancelled,
    c.made, c.active, c.completed, c.released,
    rate.numerator,
    rate.denominator,
    case
      when rate.denominator = 0 then null
      else pg_catalog.round(rate.numerator::numeric * 100 / rate.denominator, 1)
    end
  from me, l, c, rate;
$$;

------------------------------------------------------------------------------
-- my_activity_daily(days) — the caller's own series, gap-filled the same way.
--
-- Four columns rather than two, for the reason given above: which pair the
-- dashboard plots follows from `role`, and both are reported rather than
-- inferred.
------------------------------------------------------------------------------
create or replace function public.my_activity_daily(p_days integer default 90)
returns table (
  day                date,
  listings_posted    integer,
  listings_completed integer,
  claims_made        integer,
  claims_completed   integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select o.id
    from public.organizations o
    where o.owner_id = (select auth.uid())
    limit 1
  ),
  bounds as (
    select
      least(greatest(coalesce(p_days, 90), 1), 365) as days,
      (pg_catalog.now() at time zone 'UTC')::date    as today
  ),
  calendar as (
    select d::date as day
    from bounds b,
      pg_catalog.generate_series(
        b.today - (b.days - 1),
        b.today,
        interval '1 day'
      ) as d
  ),
  posted as (
    select (l.created_at at time zone 'UTC')::date as day, count(*) as n
    from public.listings l, me, bounds b
    where l.organization_id = me.id
      and (l.created_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  ),
  -- A donor's completions, dated by the claim that closed them.
  fulfilled as (
    select (c.released_at at time zone 'UTC')::date as day, count(*) as n
    from public.claims c
    join public.listings l on l.id = c.listing_id
    cross join me
    cross join bounds b
    where l.organization_id = me.id
      and c.status = 'completed'
      and c.released_at is not null
      and (c.released_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  ),
  claimed as (
    select (c.created_at at time zone 'UTC')::date as day, count(*) as n
    from public.claims c, me, bounds b
    where c.organization_id = me.id
      and (c.created_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  ),
  collected as (
    select (c.released_at at time zone 'UTC')::date as day, count(*) as n
    from public.claims c, me, bounds b
    where c.organization_id = me.id
      and c.status = 'completed'
      and c.released_at is not null
      and (c.released_at at time zone 'UTC')::date >= b.today - (b.days - 1)
    group by 1
  )
  select
    cal.day,
    coalesce(p.n, 0)::integer,
    coalesce(f.n, 0)::integer,
    coalesce(cm.n, 0)::integer,
    coalesce(co.n, 0)::integer
  from calendar cal
  left join posted    p  on p.day  = cal.day
  left join fulfilled f  on f.day  = cal.day
  left join claimed   cm on cm.day = cal.day
  left join collected co on co.day = cal.day
  order by cal.day;
$$;

------------------------------------------------------------------------------
-- Grants.
--
-- `revoke from public` alone does not do it on Supabase: `anon` holds a direct
-- privilege that PUBLIC's revoke leaves untouched, so it has to be named. M3
-- shipped without this and `anon` could call the map RPCs (see
-- 20260830230810). Every definer function added since names `anon` explicitly.
------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.network_overview()',
    'public.network_activity_daily(integer)',
    'public.network_reach()',
    'public.my_activity_summary()',
    'public.my_activity_daily(integer)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon', fn);
    execute pg_catalog.format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
