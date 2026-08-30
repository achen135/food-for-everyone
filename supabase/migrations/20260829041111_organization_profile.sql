-- M2 — organization profile.
-- The `organizations` table and its owner-scoped RLS already exist from M1;
-- this migration only tightens things and removes the redundant back-pointer.

------------------------------------------------------------------------------
-- Drop profiles.organization_id.
-- One organization per account is already enforced by the unique index on
-- organizations.owner_id, so this column was redundant *and* writable by the
-- user under profiles_update_own (auth.uid() = id says nothing about its
-- value). See Design Decisions, 2026-08-29 — delete the illegal state rather
-- than police it.
------------------------------------------------------------------------------
alter table public.profiles
  drop column if exists organization_id;

------------------------------------------------------------------------------
-- owner_id always defaults to the caller. Writes still pass it explicitly
-- (through lib/db), but this means a query that forgets to can't create an
-- orphaned / mis-owned row, and it lines up with organizations_insert_own.
------------------------------------------------------------------------------
alter table public.organizations
  alter column owner_id set default auth.uid();

------------------------------------------------------------------------------
-- Length guards. zod is the real validation layer (shared client + server),
-- but these keep a write that somehow bypasses it from storing unbounded text.
------------------------------------------------------------------------------
alter table public.organizations
  drop constraint if exists organizations_description_len,
  drop constraint if exists organizations_email_len,
  drop constraint if exists organizations_phone_len,
  drop constraint if exists organizations_website_len,
  drop constraint if exists organizations_address_len;

alter table public.organizations
  add constraint organizations_description_len
    check (description is null or char_length(description) <= 2000),
  add constraint organizations_email_len
    check (email is null or char_length(email) <= 320),
  add constraint organizations_phone_len
    check (phone is null or char_length(phone) <= 40),
  add constraint organizations_website_len
    check (website is null or char_length(website) <= 2048),
  add constraint organizations_address_len
    check (address is null or char_length(address) <= 500);

-- RLS is unchanged: M1's organizations_{select,insert,update,delete}_own
-- (to authenticated, auth.uid() = owner_id) is exactly the M2 requirement —
-- a user manages only their own organization. M3's migration widens SELECT so
-- counterparties can see each other on the map, with its own RLS review.
