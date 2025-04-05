-- M3 fix — actually lock the map RPCs to signed-in callers.
--
-- 20260830224459 did `revoke all ... from public` and granted EXECUTE to
-- `authenticated`, intending "signed-in users only". Testing against the live
-- project showed `anon` could still call both functions.
--
-- Why: `PUBLIC` is the implicit grant every role inherits, but Supabase also
-- gives `anon` and `authenticated` *direct* privileges on objects in `public`.
-- Revoking from PUBLIC does not remove a direct grant, so `anon` kept its own.
--
-- Impact was nil in practice — with no JWT, `auth.uid()` is null, the `caller`
-- CTE is empty, and the join returns zero rows — but "the data happens to be
-- empty" is not an access control. Revoke explicitly.

revoke all on function public.my_organization_point() from public, anon;
revoke all on function public.organizations_near(
  double precision, double precision, double precision, text, integer
) from public, anon;

grant execute on function public.my_organization_point() to authenticated;
grant execute on function public.organizations_near(
  double precision, double precision, double precision, text, integer
) to authenticated;
