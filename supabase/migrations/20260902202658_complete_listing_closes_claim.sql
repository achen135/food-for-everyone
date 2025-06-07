-- M6 fix, part 2 of 2 — completing a listing closes out its claim.
--
-- The bug: `complete_listing` set `listings.status = 'completed'` and never
-- touched `claims`. The claim stayed `active`, so `my_claims()` — which filters
-- on `active` — kept returning finished pickups forever, with nothing the
-- recipient could do to clear them. M8's fulfilment-rate chart would have
-- counted them as still outstanding.
--
-- Two changes, and they have to ship together. Fixing either alone makes
-- something worse.

------------------------------------------------------------------------------
-- 1. Completion closes the claim — as `completed`, not `released`.
--
-- `released` means the recipient gave the food back. `completed` means they
-- collected it. Both leave the claim inactive, so it is tempting to reuse the
-- existing value, but they are opposite outcomes: M8's fulfilment rate is
-- exactly "completed ÷ claimed", and "who backed out" is the other half of that
-- signal. Conflating them would leave the two indistinguishable in the history
-- with no way to recover the difference later.
------------------------------------------------------------------------------
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

  update public.claims
  set status = 'completed', released_at = pg_catalog.now()
  where listing_id = p_listing_id
    and status = 'active';

  return 'ok';
end $$;

------------------------------------------------------------------------------
-- 2. `listing_claimed_by_me` admits any claim, not just an active one.
--
-- This is not tidying. Supabase Realtime decides who receives a row change by
-- running the table's SELECT policy against the subscriber, and
-- `listings_select_visible` reaches the recipient's own claimed rows through
-- this function. So the moment a listing stops matching, the recipient stops
-- being told anything about it.
--
-- With the `active` filter still in place, change (1) above would fire both
-- conditions at once: status leaves `open` *and* the claim leaves `active`, so
-- the row would vanish from the recipient's visibility in the same transaction
-- that completed it — and the completion notification would never be delivered.
-- The recipient's screen would simply stop updating.
--
-- `cancel_listing` already has this problem and is silent to the recipient
-- today for exactly this reason. Completion only notifies at all *by accident*,
-- because the claim was wrongly left active; fixing the claim without this
-- would silence it too, turning one bug into two.
--
-- Admitting any claim keeps a completed or cancelled listing visible to the
-- recipient who held it — which is also what you want for history — and both
-- transitions now notify. `my_claims()` still filters on `active`, so the
-- claims list itself stays clean.
------------------------------------------------------------------------------
create or replace function public.listing_claimed_by_me(p_listing_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.claims c
    where c.listing_id = p_listing_id
      and c.organization_id = public.my_organization_id()
  );
$$;
