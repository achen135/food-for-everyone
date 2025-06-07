-- M6 fix, part 1 of 2 — add the `completed` claim status. Nothing else.
--
-- This file does one thing on purpose. Postgres will not let a newly added enum
-- value be *used* in the same transaction that adds it ("unsafe use of new
-- value ... of enum type"), and the Supabase CLI runs each migration file in
-- its own transaction. So the value has to be committed by one migration before
-- another can reference it. Part 2 (20260902202658) changes the functions.
--
-- `if not exists` so a re-run is harmless — enum values cannot be dropped, and
-- there is no sensible down migration for one.

alter type public.claim_status add value if not exists 'completed';
