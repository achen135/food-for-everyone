-- M10 — an append-only `events` log, and an emit inside every donation
-- lifecycle transition.
--
-- This is the one web-side schema change the ML subsystem needs
-- (docs/ML Subsystem.md §4). Nothing in the product reads this table; the
-- `ml/` side consumes it with the service-role key.
--
-- ## Why a log rather than reading listings/claims
--
-- The live tables have no history. `listings.status` is overwritten in place,
-- so the moment a listing is claimed, the fact that it was ever open is gone —
-- and with it, when it stopped being true. A model that has to answer "as of
-- 14:00 on the 3rd, what did we know about this listing?" cannot get that from
-- a mutable row, and a nightly dump loses intra-day ordering. Every row here
-- carries the instant it became true, which is what makes point-in-time
-- correct features possible and leakage structurally avoidable.
--
-- ## Five event types, not the four the handoff listed
--
-- There are five write functions, and the fifth — `cancel_listing`, a donor
-- withdrawing an offer — has no honest home among the four when the listing
-- was never claimed: no claim existed to cancel.
--
-- Leaving it unrecorded is not neutral. The ML label is "posted, pickup_end
-- passed, never claimed" = wasted food. A donor who withdraws an unclaimed
-- listing — sold it, posted it twice — and lets the window pass would land in
-- that set, and the log would hold nothing to say otherwise: a false positive
-- baked into the training labels, invisible to the pipeline. So withdrawal
-- gets its own type and the label can exclude it.
--
-- `event_type` is `text` + a check constraint rather than an enum precisely so
-- this stays cheap. Adding a value is one ALTER in one migration, with none of
-- the two-file dance a new enum value forces (see 20260902202657).
--
-- Still no `listing_expired`, and still no cron. Expiry is a fact about the
-- clock, not something a person does; the pipeline derives it from
-- `payload.pickup_end` and the absence of a `listing_claimed`. That is the M6
-- header's "Expiry stays derived" decision, held to here.
--
-- ## Why there are no foreign keys
--
-- `listing_id`, `claim_id` and `actor_org_id` are plain uuids, deliberately.
-- An append-only table cannot hold an enforced FK into a table whose rows get
-- deleted, because every ON DELETE action contradicts it:
--
--   cascade   -> DELETE on events, which the append-only trigger rejects
--   set null  -> UPDATE on events, which the append-only trigger rejects
--   restrict  -> the parent delete fails instead
--
-- That is not theoretical. `npm run db:seed -- --reset` deletes seed auth
-- users, which cascades auth.users -> organizations -> listings -> claims, and
-- `--reset-activity` deletes listings outright. With an FK, either every seed
-- reset would abort or the log would silently lose the rows it exists to keep.
--
-- The integrity an FK would buy is not needed here: `payload` carries a
-- denormalised snapshot so the feature pipeline never joins back to a mutable
-- row, and the log is supposed to outlive what it describes — an org's history
-- is still training data after the org is gone. The ml side treats the ids as
-- opaque and tolerates a dangling one.

------------------------------------------------------------------------------
-- events
--
-- `payload` is a denormalised snapshot, per event type. The contract:
--
--   listing_posted     actor = donor
--                      donor_org_id, donor_lat, donor_lng, donor_verified,
--                      title, quantity, notes_length,
--                      pickup_start, pickup_end
--
--   listing_claimed    actor = recipient
--                      donor_org_id, donor_lat, donor_lng, donor_verified,
--                      recipient_org_id, recipient_lat, recipient_lng,
--                      distance_km, pickup_start, pickup_end
--
--   claim_completed    actor = donor (the donor marks a pickup collected)
--                      donor_org_id, recipient_org_id, pickup_end, claimed_at
--
--   claim_cancelled    actor = recipient (release_claim — they hand it back)
--                      donor_org_id, recipient_org_id, pickup_end, claimed_at,
--                      cancelled_by = 'recipient'
--
--   listing_cancelled  actor = donor (cancel_listing — they withdraw it)
--                      donor_org_id, pickup_end, cancelled_by = 'donor',
--                      displaced_claim_id, displaced_recipient_org_id,
--                      displaced_claimed_at  (all null if it was unclaimed)
--
-- `pickup_end` is on every type because it is the label-critical field and no
-- pipeline should have to join to find it. Otherwise facts are not repeated:
-- events are immutable, so joining event-to-event by listing_id is safe in a
-- way that joining back to `listings` is not.
--
-- `notes_length` rather than the notes themselves. The length is the feature
-- (how much detail a donor wrote); the text is donor-authored free-form and
-- the likeliest place for an incidental phone number or name to end up. This
-- log leaves the product and is read by another subsystem, so it keeps the
-- signal and drops the prose — consistent with the CLAUDE.md rule that only
-- org-level fields ever leave the product surface.
------------------------------------------------------------------------------
create table if not exists public.events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  event_type     text not null check (event_type in (
                   'listing_posted',
                   'listing_claimed',
                   'claim_completed',
                   'claim_cancelled',
                   'listing_cancelled'
                 )),
  listing_id     uuid,
  claim_id       uuid,
  actor_org_id   uuid,
  payload        jsonb not null default '{}'::jsonb,
  schema_version smallint not null default 1
);

-- The ml side's cursor: "everything since (t, id)", stable across ties.
create index if not exists events_occurred_at_idx
  on public.events (occurred_at, id);

create index if not exists events_event_type_idx
  on public.events (event_type);

create index if not exists events_listing_idx
  on public.events (listing_id)
  where listing_id is not null;

-- Partial: only two of the five types carry a claim, so most rows are null and
-- the only useful lookup is by a real claim id.
create index if not exists events_claim_idx
  on public.events (claim_id)
  where claim_id is not null;

------------------------------------------------------------------------------
-- Append-only, enforced twice.
--
-- 1. Grants. `revoke from public` alone is NOT enough on Supabase — anon and
--    authenticated hold direct privileges that PUBLIC's revoke leaves in place.
--    Name them (M3 shipped this bug; see Sessions 2026-08-30). Nothing is
--    granted back: clients neither read nor write this table. Inserts arrive
--    through the `security definer` transition functions, which execute as the
--    table owner and so are not subject to these grants at all.
--
-- 2. A trigger, so the rule holds against anything that gets past the grants —
--    including the service-role key, which the ml side uses and which bypasses
--    RLS entirely. Grants alone would leave the guarantee resting on a key that
--    is handed to another subsystem by design.
--
-- RLS is enabled with no policies of any kind. For anon and authenticated that
-- is a total denial, which is the intent: there is no client SELECT policy
-- because there is no client read.
--
-- The escape hatch is deliberate and narrow: repairing bad data means a
-- migration that explicitly disables the trigger, does the work, and re-enables
-- it. There is no way to do it by accident.
------------------------------------------------------------------------------
alter table public.events enable row level security;

revoke all on table public.events from public, anon, authenticated;

create or replace function public.events_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'events is append-only: % is not permitted', pg_catalog.upper(tg_op)
    using errcode = 'insufficient_privilege',
          hint = 'Append a corrective event instead. Repairing history requires a migration that explicitly disables this trigger.';
  return null;
end $$;

drop trigger if exists events_no_update on public.events;
create trigger events_no_update
  before update on public.events
  for each row execute function public.events_append_only();

drop trigger if exists events_no_delete on public.events;
create trigger events_no_delete
  before delete on public.events
  for each row execute function public.events_append_only();

-- TRUNCATE is not a DELETE and row-level triggers never see it.
drop trigger if exists events_no_truncate on public.events;
create trigger events_no_truncate
  before truncate on public.events
  for each statement execute function public.events_append_only();

------------------------------------------------------------------------------
-- The emit helper.
--
-- Deliberately NOT `security definer`. It runs with the privileges of whoever
-- is executing, and every caller is already a `security definer` function
-- running as the table owner — so the insert works there, and only there. If
-- execute on this function ever leaked to `authenticated`, an invoker-rights
-- function would still hit RLS with no insert policy and be refused, whereas a
-- definer one would happily forge events on the caller's behalf. Execute is
-- revoked below regardless; this is the second line.
------------------------------------------------------------------------------
create or replace function public.record_event(
  p_event_type   text,
  p_listing_id   uuid,
  p_claim_id     uuid,
  p_actor_org_id uuid,
  p_payload      jsonb
)
returns void language sql set search_path = '' as $$
  insert into public.events (
    event_type, listing_id, claim_id, actor_org_id, payload
  ) values (
    p_event_type, p_listing_id, p_claim_id, p_actor_org_id,
    coalesce(p_payload, '{}'::jsonb)
  );
$$;

revoke all on function public.record_event(text, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;

------------------------------------------------------------------------------
-- The emits.
--
-- Each of the five write functions is replaced with the same function plus one
-- `record_event` call. Signatures, guards, result codes and ordering are
-- untouched — the only behavioural difference is that a transition now also
-- writes a row here, in the same transaction that made the change.
--
-- In-transaction is the point, and it is a real tradeoff: if the insert raises,
-- the transition rolls back with it and a donor's listing is not posted. That
-- is the side to fail on. The alternative — emit after commit, best-effort —
-- produces a log with holes in it, and a hole is indistinguishable from
-- "nothing happened", which is exactly the inference the ML label depends on.
-- A missing event silently corrupts training data; a rolled-back transaction is
-- loud and immediate. See docs/Design Decisions.md.
--
-- The three functions that needed a value they were not previously capturing
-- (`create_listing` the new listing id, `claim_listing` the new claim id,
-- `complete_listing` / `cancel_listing` the claim they close) get it with
-- RETURNING ... INTO, which changes no rows and no result codes.
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
  v_org        uuid := public.my_organization_id();
  v_type       public.organization_type := public.my_organization_type();
  v_notes      text := nullif(pg_catalog.btrim(p_notes), '');
  v_listing_id uuid;
begin
  if v_org is null then return 'no_organization'; end if;
  if v_type is distinct from 'donor' then return 'not_donor'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;
  if p_pickup_end <= p_pickup_start then return 'bad_window'; end if;

  insert into public.listings (
    organization_id, title, quantity, pickup_start, pickup_end, notes
  ) values (
    v_org, p_title, p_quantity, p_pickup_start, p_pickup_end, v_notes
  )
  returning id into v_listing_id;

  perform public.record_event(
    'listing_posted', v_listing_id, null, v_org,
    (select pg_catalog.jsonb_build_object(
       'donor_org_id',   v_org,
       'donor_lat',      extensions.st_y(o.location::extensions.geometry),
       'donor_lng',      extensions.st_x(o.location::extensions.geometry),
       'donor_verified', o.verified,
       'title',          p_title,
       'quantity',       p_quantity,
       'notes_length',   coalesce(char_length(v_notes), 0),
       'pickup_start',   p_pickup_start,
       'pickup_end',     p_pickup_end
     )
     from public.organizations o
     where o.id = v_org)
  );

  return 'ok';
end $$;

-- The contended one. FOR UPDATE serialises concurrent claimers on the listing
-- row: the second caller blocks until the first commits, then re-reads status
-- as 'claimed' and is turned away. Without the lock both would read 'open'.
create or replace function public.claim_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid := public.my_organization_id();
  v_type     public.organization_type := public.my_organization_type();
  v_status   public.listing_status;
  v_start    timestamptz;
  v_end      timestamptz;
  v_donor    uuid;
  v_claim_id uuid;
begin
  if v_org is null then return 'no_organization'; end if;
  if v_type is distinct from 'recipient' then return 'not_recipient'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  select l.status, l.pickup_start, l.pickup_end, l.organization_id
    into v_status, v_start, v_end, v_donor
  from public.listings l
  where l.id = p_listing_id
  for update;

  if not found then return 'not_found'; end if;
  if v_status <> 'open' then return 'already_claimed'; end if;
  if v_end <= pg_catalog.now() then return 'expired'; end if;

  insert into public.claims (listing_id, organization_id)
  values (p_listing_id, v_org)
  returning id into v_claim_id;

  update public.listings set status = 'claimed' where id = p_listing_id;

  perform public.record_event(
    'listing_claimed', p_listing_id, v_claim_id, v_org,
    (select pg_catalog.jsonb_build_object(
       'donor_org_id',     v_donor,
       'donor_lat',        extensions.st_y(d.location::extensions.geometry),
       'donor_lng',        extensions.st_x(d.location::extensions.geometry),
       'donor_verified',   d.verified,
       'recipient_org_id', v_org,
       'recipient_lat',    extensions.st_y(r.location::extensions.geometry),
       'recipient_lng',    extensions.st_x(r.location::extensions.geometry),
       'distance_km',      extensions.st_distance(d.location, r.location) / 1000.0,
       'pickup_start',     v_start,
       'pickup_end',       v_end
     )
     from public.organizations d
     cross join public.organizations r
     where d.id = v_donor and r.id = v_org)
  );

  return 'ok';
exception
  -- The partial unique index fired: someone claimed between our read and write.
  when unique_violation then return 'already_claimed';
end $$;

-- The recipient hands it back. The claim ends without a pickup, and the listing
-- goes back on offer — so this is a claim-level cancellation, not a withdrawal.
create or replace function public.release_claim(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid := public.my_organization_id();
  v_claim uuid;
begin
  if v_org is null then return 'no_organization'; end if;
  if public.is_demo_account() then return 'demo_account'; end if;

  update public.claims
  set status = 'released', released_at = pg_catalog.now()
  where listing_id = p_listing_id
    and organization_id = v_org
    and status = 'active'
  returning id into v_claim;

  if not found then return 'no_claim'; end if;

  -- Back on offer, unless the donor has already closed it out.
  update public.listings
  set status = 'open'
  where id = p_listing_id and status = 'claimed';

  perform public.record_event(
    'claim_cancelled', p_listing_id, v_claim, v_org,
    (select pg_catalog.jsonb_build_object(
       'donor_org_id',     l.organization_id,
       'recipient_org_id', v_org,
       'pickup_end',       l.pickup_end,
       'claimed_at',       c.created_at,
       'cancelled_by',     'recipient'
     )
     from public.claims c
     join public.listings l on l.id = c.listing_id
     where c.id = v_claim)
  );

  return 'ok';
end $$;

create or replace function public.complete_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org       uuid := public.my_organization_id();
  v_claim     uuid;
  v_recipient uuid;
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
    and status = 'active'
  returning id, organization_id into v_claim, v_recipient;

  perform public.record_event(
    'claim_completed', p_listing_id, v_claim, v_org,
    (select pg_catalog.jsonb_build_object(
       'donor_org_id',     v_org,
       'recipient_org_id', v_recipient,
       'pickup_end',       l.pickup_end,
       'claimed_at',       c.created_at
     )
     from public.listings l
     left join public.claims c on c.id = v_claim
     where l.id = p_listing_id)
  );

  return 'ok';
end $$;

-- The donor withdraws the offer. This is the fifth transition and the reason
-- for the fifth event type: it fires whether or not anyone had claimed the
-- listing, and when nobody had, there is no claim for it to be about. The
-- displaced claim, if there was one, rides in the payload and in `claim_id`.
create or replace function public.cancel_listing(p_listing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org       uuid := public.my_organization_id();
  v_claim     uuid;
  v_recipient uuid;
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
  where listing_id = p_listing_id and status = 'active'
  returning id, organization_id into v_claim, v_recipient;

  perform public.record_event(
    'listing_cancelled', p_listing_id, v_claim, v_org,
    (select pg_catalog.jsonb_build_object(
       'donor_org_id',               v_org,
       'pickup_end',                 l.pickup_end,
       'cancelled_by',               'donor',
       'displaced_claim_id',         v_claim,
       'displaced_recipient_org_id', v_recipient,
       'displaced_claimed_at',       c.created_at
     )
     from public.listings l
     left join public.claims c on c.id = v_claim
     where l.id = p_listing_id)
  );

  return 'ok';
end $$;
