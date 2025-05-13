-- M4 fix — make the read-only demo account actually read-only.
--
-- M4 added `profiles.is_demo` enforcement to `saveOrganizationAction`. That is
-- the wrong layer for this particular account, because its credentials are
-- **published in the README**. The anon key ships to the browser, so anyone who
-- reads the README can sign in, obtain a real JWT, and talk to PostgREST
-- directly — never touching a Server Action. Verified against the live project
-- before writing this: both of the following succeeded.
--
--   1. Privilege escalation.
--      PATCH /rest/v1/profiles?id=eq.<demo>   {"is_demo": false}
--      `profiles_update_own` checks `auth.uid() = id` and says nothing about
--      *which columns* may change, so the demo account could clear its own
--      restriction flag — permanently defeating the `is_demo_account()` checks
--      inside every M6 write function too.
--
--   2. Vandalism.
--      PATCH /rest/v1/organizations?owner_id=eq.<demo>   {"name": "..."}
--      Allowed by `organizations_update_own`, bypassing the action's guard.
--      Whatever a visitor writes is then what the next visitor sees.
--
-- This is the M2 `profiles.organization_id` lesson again: a user-writable
-- column that grants privileges. The fix belongs where the boundary is.
--
-- Two independent layers, because either alone would be enough and neither
-- should be the only thing standing there:
--   (a) column privileges — `is_demo` is not user-writable by anyone;
--   (b) RLS policies — demo accounts cannot write these tables at all.

------------------------------------------------------------------------------
-- (a) `is_demo` is not a user-writable column.
--
-- Note the revoke has to be table-wide first: a table-level UPDATE grant covers
-- every column, so revoking a single column while that grant stands does
-- nothing. Revoke the table, then grant back only the columns a user may edit.
-- `full_name` is the only one — everything else on `profiles` is identity
-- (`id`), audit (`created_at`), or privilege (`is_demo`).
------------------------------------------------------------------------------
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;

------------------------------------------------------------------------------
-- (b) Demo accounts get no writes.
--
-- `is_demo_account()` (M6) is `security definer`, so calling it from inside a
-- policy on `profiles` does not re-enter that policy.
--
-- `listings` and `claims` need nothing here: they have no write policies at
-- all, so direct PostgREST writes are already denied, and their `security
-- definer` write functions each check `is_demo_account()`.
------------------------------------------------------------------------------
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id and not public.is_demo_account())
  with check ((select auth.uid()) = id and not public.is_demo_account());

drop policy if exists "organizations_insert_own" on public.organizations;
create policy "organizations_insert_own"
  on public.organizations for insert
  to authenticated
  with check ((select auth.uid()) = owner_id and not public.is_demo_account());

drop policy if exists "organizations_update_own" on public.organizations;
create policy "organizations_update_own"
  on public.organizations for update
  to authenticated
  using ((select auth.uid()) = owner_id and not public.is_demo_account())
  with check ((select auth.uid()) = owner_id and not public.is_demo_account());

drop policy if exists "organizations_delete_own" on public.organizations;
create policy "organizations_delete_own"
  on public.organizations for delete
  to authenticated
  using ((select auth.uid()) = owner_id and not public.is_demo_account());
