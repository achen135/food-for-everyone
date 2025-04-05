-- M3 — map: counterparty radius query.
--
-- Design note (RLS review in docs/Sessions.md, 2026-08-30):
-- The obvious move here is to widen `organizations_select_own` so counterparties
-- can read each other. We deliberately do NOT. Two reasons:
--
--  1. The anon key ships to the browser, so a signed-in user can call PostgREST
--     directly with their own JWT. A widened row policy would hand them every
--     column of every counterparty row — including `owner_id`, a real auth user
--     id we have no reason to publish. RLS is row-level; it cannot narrow columns.
--  2. Failing safe. With the table left own-row-only, a future
--     `.from("organizations").select("*")` that forgets to scope still returns
--     just the caller's row. Widening the policy would make that same slip leak
--     the directory silently.
--
-- Instead the map reads through one `security definer` function with an explicit
-- return shape. Authorization lives in the function body and is derived from
-- `auth.uid()` — never from a caller-supplied argument. The base table stays shut.

------------------------------------------------------------------------------
-- The caller's own coordinates, for centring the map without a geolocation
-- prompt. `location` is a geography column; PostgREST hands back hex EWKB on a
-- plain select, so we extract lat/lng in SQL instead of parsing it in JS.
------------------------------------------------------------------------------
create or replace function public.my_organization_point()
returns table (
  latitude  double precision,
  longitude double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    extensions.st_y(o.location::extensions.geometry),
    extensions.st_x(o.location::extensions.geometry)
  from public.organizations o
  where o.owner_id = (select auth.uid())
    and o.location is not null
  limit 1;
$$;

------------------------------------------------------------------------------
-- Counterparties within `radius_km` of a point, nearest first.
--
-- Returns an explicit column list — no `owner_id`, no timestamps. Per the
-- architecture rule in CLAUDE.md, map responses carry org-level fields only and
-- never anything about the person who registered the org.
--
-- `search` filters on name only, and is escaped for LIKE metacharacters so a
-- query of "100%" means the literal string, not a wildcard.
------------------------------------------------------------------------------
create or replace function public.organizations_near(
  center_lat  double precision,
  center_lng  double precision,
  radius_km   double precision,
  search      text default null,
  max_results integer default 500
)
returns table (
  id          uuid,
  name        text,
  type        public.organization_type,
  description text,
  email       text,
  phone       text,
  website     text,
  address     text,
  verified    boolean,
  latitude    double precision,
  longitude   double precision,
  distance_km double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  with caller as (
    -- Who is asking, and therefore which side they are allowed to see.
    -- Derived from the JWT, never from an argument. No org => no rows.
    select o.type
    from public.organizations o
    where o.owner_id = (select auth.uid())
    limit 1
  ),
  params as (
    select
      extensions.st_setsrid(
        extensions.st_makepoint(
          least(greatest(coalesce(center_lng, 0), -180), 180),
          least(greatest(coalesce(center_lat, 0), -90), 90)
        ),
        4326
      )::extensions.geography as center,
      -- Clamp the radius so a hand-written request can't ask for the planet.
      least(greatest(coalesce(radius_km, 25), 0.1), 200) * 1000 as radius_m,
      nullif(btrim(coalesce(search, '')), '') as q
  )
  select
    o.id,
    o.name,
    o.type,
    o.description,
    o.email,
    o.phone,
    o.website,
    o.address,
    o.verified,
    extensions.st_y(o.location::extensions.geometry) as latitude,
    extensions.st_x(o.location::extensions.geometry) as longitude,
    extensions.st_distance(o.location, p.center) / 1000.0 as distance_km
  from public.organizations o
  cross join params p
  join caller c on o.type <> c.type
  where o.location is not null
    and extensions.st_dwithin(o.location, p.center, p.radius_m)
    and (
      p.q is null
      or o.name ilike
        '%' ||
        replace(replace(replace(p.q, '\', '\\'), '%', '\%'), '_', '\_') ||
        '%'
    )
  order by extensions.st_distance(o.location, p.center)
  limit least(greatest(coalesce(max_results, 500), 1), 500);
$$;

------------------------------------------------------------------------------
-- Only signed-in users may call these. `public` holds EXECUTE by default, so
-- revoke first, then grant narrowly.
--
-- NOTE: this revoke is incomplete — Supabase also grants `anon` privileges
-- directly, which revoking from PUBLIC does not remove. Fixed in
-- 20260830230810_lock_map_rpcs_to_authenticated.sql. Left as-is here because
-- this migration is already applied; never edit an applied migration.
------------------------------------------------------------------------------
revoke all on function public.my_organization_point() from public;
revoke all on function public.organizations_near(
  double precision, double precision, double precision, text, integer
) from public;

grant execute on function public.my_organization_point() to authenticated;
grant execute on function public.organizations_near(
  double precision, double precision, double precision, text, integer
) to authenticated;
