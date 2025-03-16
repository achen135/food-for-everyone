-- M1 — core schema: profiles + organizations, with RLS and a signup trigger.
-- Applied with `supabase db push` (or pasted into the SQL editor). Idempotent
-- where practical so a re-run during setup is safe.

-- PostGIS: needed for organizations.location + the M3 radius query. Supabase
-- keeps extensions in the dedicated `extensions` schema.
create extension if not exists postgis with schema extensions;

------------------------------------------------------------------------------
-- Enums
------------------------------------------------------------------------------
do $$
begin
  create type public.organization_type as enum ('donor', 'recipient');
exception
  when duplicate_object then null;
end
$$;

------------------------------------------------------------------------------
-- updated_at helper
------------------------------------------------------------------------------
-- empty search_path per Supabase hardening guidance (Postgres always searches
-- pg_catalog first, but we schema-qualify anyway to be explicit).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end
$$;

------------------------------------------------------------------------------
-- organizations
------------------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 200),
  type        public.organization_type not null,
  description text,
  email       text,
  phone       text,
  website     text,
  address     text,
  location    extensions.geography(Point, 4326),
  verified    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One organization per account for v1 (see Spec §6 / Design Decisions).
create unique index if not exists organizations_owner_id_key
  on public.organizations (owner_id);

create index if not exists organizations_location_gix
  on public.organizations using gist (location);

create index if not exists organizations_type_idx
  on public.organizations (type);

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
------------------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  full_name       text,
  organization_id uuid references public.organizations (id) on delete set null,
  created_at      timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Auto-create a profile row when an auth user is created.
-- security definer so it can write past RLS; empty search_path per Supabase
-- hardening guidance (everything below is schema-qualified).
------------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------------------
-- Row Level Security
------------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.organizations enable row level security;

-- profiles: each user sees and edits only their own row.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- organizations: for M1, a user only touches their own organization.
-- M3 widens SELECT to let counterparties see each other on the map (that
-- change ships in the M3 migration, with its own RLS review).
drop policy if exists "organizations_select_own" on public.organizations;
create policy "organizations_select_own"
  on public.organizations for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "organizations_insert_own" on public.organizations;
create policy "organizations_insert_own"
  on public.organizations for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "organizations_update_own" on public.organizations;
create policy "organizations_update_own"
  on public.organizations for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "organizations_delete_own" on public.organizations;
create policy "organizations_delete_own"
  on public.organizations for delete
  to authenticated
  using ((select auth.uid()) = owner_id);
