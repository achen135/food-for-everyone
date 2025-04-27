-- M6 — donation listings and claims.
--
-- Shape of the access model (RLS review in docs/Sessions.md, 2026-08-31):
--
--   READS  are RLS policies. Recipients genuinely need to see other orgs' rows,
--          and Supabase Realtime decides who receives a change by running the
--          SELECT policy — so a read path hidden inside a function would get no
--          live updates at all. Everything a recipient can see this way is
--          content a donor published *in order to be seen*.
--
--   WRITES have no policies at all, which means the tables deny them. Every
--          mutation goes through a `security definer` function that validates
--          the transition. This is the M3 pattern and it matters more here:
--          `listings.status` is a state machine, and a plain UPDATE policy
--          cannot express "open may become claimed, but completed may not
--          become open".
--
-- Claiming is a race — two recipients pressing Claim on the last crate of
-- produce. `claim_listing` locks the row with SELECT ... FOR UPDATE and a
-- partial unique index backs it up, so exactly one wins.

------------------------------------------------------------------------------
-- Enums
--
-- No `expired` here on purpose. Expiry is a fact about the clock
-- (`pickup_end < now()`), not a state someone transitions into, and storing it
-- would need a cron to stay true — a second source of truth that is wrong
-- between ticks. It is derived everywhere it is needed.
------------------------------------------------------------------------------
do $$ begin
  create type public.listing_status as enum ('open', 'claimed', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.claim_status as enum ('active', 'released');
exception when duplicate_object then null; end $$;

------------------------------------------------------------------------------
-- Demo-account flag.
--
-- The read-only demo login (Spec §10) does not exist yet, but its rule does:
-- a demo user must not be able to post or claim. Adding the column and the
-- checks now means creating that account later is a data change, not a code
-- change — and there is no window where the account exists and the guard
-- doesn't. Enforced server-side in every write function, never by hiding UI.
------------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_demo boolean not null default false;

------------------------------------------------------------------------------
-- Helpers. All `security definer` so they can be called from inside an RLS
-- policy without re-entering that policy (which would recurse).
------------------------------------------------------------------------------
create or replace function public.my_organization_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select o.id from public.organizations o
  where o.owner_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.my_organization_type()
returns public.organization_type language sql stable security definer set search_path = '' as $$
  select o.type from public.organizations o
  where o.owner_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.is_demo_account()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.is_demo from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

------------------------------------------------------------------------------
-- listings
------------------------------------------------------------------------------
create table if not exists public.listings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 120),
  quantity        text not null check (char_length(quantity) between 1 and 80),
  pickup_start    timestamptz not null,
  pickup_end      timestamptz not null,
  notes           text check (notes is null or char_length(notes) <= 1000),
  status          public.listing_status not null default 'open',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint listings_pickup_window check (pickup_end > pickup_start)
);

create index if not exists listings_organization_idx
  on public.listings (organization_id, created_at desc);

-- Drives the browse query: open listings that haven't run out of time.
create index if not exists listings_open_idx
  on public.listings (status, pickup_end)
  where status = 'open';

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------------
-- claims
--
-- Claims are kept after release rather than deleted: M8's fulfilment-rate
-- chart needs the history, and "who backed out" is real information.
------------------------------------------------------------------------------
create table if not exists public.claims (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references public.listings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status          public.claim_status not null default 'active',
  created_at      timestamptz not null default now(),
  released_at     timestamptz
);

-- At most one live claim per listing. This is the database-level guarantee
-- behind claim_listing's row lock — belt and braces on the race.
create unique index if not exists claims_one_active_per_listing
  on public.claims (listing_id)
  where status = 'active';

create index if not exists claims_organization_idx
  on public.claims (organization_id, created_at desc);

------------------------------------------------------------------------------
-- Ownership helpers, used by the SELECT policies below. Security definer so
-- listings' policy can consult claims and vice versa without mutual recursion.
------------------------------------------------------------------------------
create or replace function public.listing_claimed_by_me(p_listing_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.claims c
    where c.listing_id = p_listing_id
      and c.organization_id = public.my_organization_id()
      and c.status = 'active'
  );
$$;

create or replace function public.listing_owned_by_me(p_listing_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.listings l
    where l.id = p_listing_id
      and l.organization_id = public.my_organization_id()
  );
$$;

------------------------------------------------------------------------------
-- Row Level Security — SELECT only. No write policies, so writes are denied
-- and must go through the functions further down.
------------------------------------------------------------------------------
alter table public.listings enable row level security;
alter table public.claims   enable row level security;

-- A donor sees their own listings in every state. A recipient sees what is
-- still on offer, plus anything they hold a live claim on (otherwise their own
-- claim would vanish from view the moment they made it).
drop policy if exists "listings_select_visible" on public.listings;
create policy "listings_select_visible"
  on public.listings for select
  to authenticated
  using (
    organization_id = public.my_organization_id()
    or (
      public.my_organization_type() = 'recipient'
      and (status = 'open' or public.listing_claimed_by_me(id))
    )
  );

-- Both sides of a claim can see it: the recipient who made it, and the donor
-- whose listing it is.
drop policy if exists "claims_select_visible" on public.claims;
create policy "claims_select_visible"
  on public.claims for select
  to authenticated
  using (
    organization_id = public.my_organization_id()
    or public.listing_owned_by_me(listing_id)
  );

------------------------------------------------------------------------------
-- Realtime. postgres_changes only delivers rows the subscriber's SELECT policy
-- admits, so the policies above are doing double duty: read authorization and
-- fan-out. Adding a table twice raises, hence the guard.
------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Supabase creates this publication on every project, but don't assume it:
  -- an ALTER against a missing publication raises undefined_object, which would
  -- abort the whole migration over an optional feature.
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    raise notice 'supabase_realtime publication not found — skipping Realtime setup';
    return;
  end if;

  foreach t in array array['listings', 'claims'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute pg_catalog.format(
        'alter publication supabase_realtime add table public.%I', t
      );
    end if;
  end loop;
end $$;

------------------------------------------------------------------------------
-- Writes.
--
-- Each returns a text result code rather than raising. The caller maps codes to
-- messages, which keeps user-facing copy in TypeScript, makes every branch
-- straightforward to test, and avoids leaking SQL error text to the client.
--   ok | no_organization | not_donor | not_recipient | demo_account
--   | not_found | not_open | expired | already_claimed | no_claim | not_claimed
------------------------------------------------------------------------------

create or replace function public.create_listing(
  p_title        text,
  p_quantity     text,
  p_pickup_start timestamptz,
  p_pickup_end   timestamptz,
  p_notes        text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := public.my_organization_id();
  v_type public.organization_type := public.my_organization_type();
begin
  if v_org is null then return 'no_organization'; end if;
  if v_type is distinct from 'donor' then return 'not_donor'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;
  if p_pickup_end <= p_pickup_start then return 'bad_window'; end if;

  insert into public.listings (
    organization_id, title, quantity, pickup_start, pickup_end, notes
  ) values (
    v_org, p_title, p_quantity, p_pickup_start, p_pickup_end,
    nullif(pg_catalog.btrim(p_notes), '')
  );

  return 'ok';
end $$;

-- The contended one. FOR UPDATE serialises concurrent claimers on the listing
-- row: the second caller blocks until the first commits, then re-reads status
-- as 'claimed' and is turned away. Without the lock both would read 'open'.
create or replace function public.claim_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org    uuid := public.my_organization_id();
  v_type   public.organization_type := public.my_organization_type();
  v_status public.listing_status;
  v_end    timestamptz;
begin
  if v_org is null then return 'no_organization'; end if;
  if v_type is distinct from 'recipient' then return 'not_recipient'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  select l.status, l.pickup_end into v_status, v_end
  from public.listings l
  where l.id = p_listing_id
  for update;

  if not found then return 'not_found'; end if;
  if v_status <> 'open' then return 'already_claimed'; end if;
  if v_end <= pg_catalog.now() then return 'expired'; end if;

  insert into public.claims (listing_id, organization_id)
  values (p_listing_id, v_org);

  update public.listings set status = 'claimed' where id = p_listing_id;

  return 'ok';
exception
  -- The partial unique index fired: someone claimed between our read and write.
  when unique_violation then return 'already_claimed';
end $$;

create or replace function public.release_claim(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.my_organization_id();
begin
  if v_org is null then return 'no_organization'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  update public.claims
  set status = 'released', released_at = pg_catalog.now()
  where listing_id = p_listing_id
    and organization_id = v_org
    and status = 'active';

  if not found then return 'no_claim'; end if;

  -- Back on offer, unless the donor has already closed it out.
  update public.listings
  set status = 'open'
  where id = p_listing_id and status = 'claimed';

  return 'ok';
end $$;

create or replace function public.complete_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.my_organization_id();
begin
  if v_org is null then return 'no_organization'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  update public.listings
  set status = 'completed'
  where id = p_listing_id
    and organization_id = v_org
    and status = 'claimed';

  if not found then return 'not_claimed'; end if;
  return 'ok';
end $$;

create or replace function public.cancel_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.my_organization_id();
begin
  if v_org is null then return 'no_organization'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  update public.listings
  set status = 'cancelled'
  where id = p_listing_id
    and organization_id = v_org
    and status in ('open', 'claimed');

  if not found then return 'not_open'; end if;

  -- Whoever was holding it needs to stop expecting food.
  update public.claims
  set status = 'released', released_at = pg_catalog.now()
  where listing_id = p_listing_id and status = 'active';

  return 'ok';
end $$;

------------------------------------------------------------------------------
-- Reads. Enriched with the counterparty's contact details, which the caller
-- cannot select directly (organizations stays own-row only — see M3).
-- Org-level fields only; nothing about the person who registered the org.
------------------------------------------------------------------------------

create or replace function public.browse_open_listings(
  radius_km   double precision default 50,
  search      text default null,
  max_results integer default 200
)
returns table (
  id                uuid,
  title             text,
  quantity          text,
  pickup_start      timestamptz,
  pickup_end        timestamptz,
  notes             text,
  status            public.listing_status,
  created_at        timestamptz,
  donor_name        text,
  donor_address     text,
  donor_email       text,
  donor_phone       text,
  donor_verified    boolean,
  distance_km       double precision,
  claimed_by_me     boolean
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select o.id, o.type, o.location
    from public.organizations o
    where o.owner_id = (select auth.uid())
  ),
  params as (
    select least(greatest(coalesce(radius_km, 50), 0.1), 200) * 1000 as radius_m,
           nullif(pg_catalog.btrim(coalesce(search, '')), '') as q
  )
  select
    l.id, l.title, l.quantity, l.pickup_start, l.pickup_end, l.notes,
    l.status, l.created_at,
    d.name, d.address, d.email, d.phone, d.verified,
    extensions.st_distance(d.location, me.location) / 1000.0,
    public.listing_claimed_by_me(l.id)
  from public.listings l
  join public.organizations d on d.id = l.organization_id
  cross join me
  cross join params p
  where me.type = 'recipient'
    and l.status = 'open'
    and l.pickup_end > pg_catalog.now()
    and d.location is not null
    and me.location is not null
    and extensions.st_dwithin(d.location, me.location, p.radius_m)
    and (
      p.q is null
      or l.title ilike '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p.q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      or d.name ilike '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p.q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  order by extensions.st_distance(d.location, me.location)
  limit least(greatest(coalesce(max_results, 200), 1), 200);
$$;

-- A donor's own listings, with whoever currently holds each one.
create or replace function public.my_listings()
returns table (
  id                uuid,
  title             text,
  quantity          text,
  pickup_start      timestamptz,
  pickup_end        timestamptz,
  notes             text,
  status            public.listing_status,
  created_at        timestamptz,
  claimant_name     text,
  claimant_email    text,
  claimant_phone    text,
  claimed_at        timestamptz
)
language sql stable security definer set search_path = '' as $$
  select
    l.id, l.title, l.quantity, l.pickup_start, l.pickup_end, l.notes,
    l.status, l.created_at,
    r.name, r.email, r.phone, c.created_at
  from public.listings l
  left join public.claims c
    on c.listing_id = l.id and c.status = 'active'
  left join public.organizations r on r.id = c.organization_id
  where l.organization_id = public.my_organization_id()
  order by l.created_at desc
  limit 200;
$$;

-- A recipient's live claims, with the donor's contact details.
create or replace function public.my_claims()
returns table (
  id             uuid,
  listing_id     uuid,
  title          text,
  quantity       text,
  pickup_start   timestamptz,
  pickup_end     timestamptz,
  notes          text,
  status         public.listing_status,
  claimed_at     timestamptz,
  donor_name     text,
  donor_address  text,
  donor_email    text,
  donor_phone    text
)
language sql stable security definer set search_path = '' as $$
  select
    c.id, l.id, l.title, l.quantity, l.pickup_start, l.pickup_end, l.notes,
    l.status, c.created_at,
    d.name, d.address, d.email, d.phone
  from public.claims c
  join public.listings l on l.id = c.listing_id
  join public.organizations d on d.id = l.organization_id
  where c.organization_id = public.my_organization_id()
    and c.status = 'active'
  order by l.pickup_start asc
  limit 200;
$$;

------------------------------------------------------------------------------
-- Grants.
--
-- `revoke from public` alone is NOT enough on Supabase: anon and authenticated
-- hold direct privileges that PUBLIC's revoke does not touch. Name anon
-- explicitly. (M3 shipped this bug; see Sessions 2026-08-30.)
------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.my_organization_id()',
    'public.my_organization_type()',
    'public.is_demo_account()',
    'public.listing_claimed_by_me(uuid)',
    'public.listing_owned_by_me(uuid)',
    'public.create_listing(text, text, timestamptz, timestamptz, text)',
    'public.claim_listing(uuid)',
    'public.release_claim(uuid)',
    'public.complete_listing(uuid)',
    'public.cancel_listing(uuid)',
    'public.browse_open_listings(double precision, text, integer)',
    'public.my_listings()',
    'public.my_claims()'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon', fn);
    execute pg_catalog.format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
