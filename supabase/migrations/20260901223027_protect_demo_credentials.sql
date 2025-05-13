-- M4 fix (2/2) — the demo account's credentials are immutable.
--
-- The previous migration stopped the demo account writing *data*. It could
-- still change its own **password**, which is worse in practice: the
-- credentials are published in the README, so any visitor could sign in, call
-- `auth.updateUser({ password })`, and lock everyone else out permanently.
-- Verified against the live project — the published password stopped working
-- immediately. For a demo whose entire job is "a recruiter can open this in 90
-- seconds", that is a one-click denial of service.
--
-- RLS can't help here: `auth.users` is GoTrue's table, not ours. A trigger can.
--
-- Why the guard is unconditional rather than exempting admins: a self-service
-- password change and the seed script's `admin.updateUserById` both reach
-- Postgres through GoTrue as the same role, so there is no honest way to tell
-- them apart from inside the trigger. Rather than invent one, the credentials
-- are simply immutable, and `supabase/seed/run.ts` recovers by deleting and
-- recreating the account (DELETE + INSERT, which this trigger does not touch).
-- "To change the demo's credentials, recreate it" is a rule that holds without
-- exceptions, which is the kind that stays true.

create or replace function public.protect_demo_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Scoped to credential columns on purpose. GoTrue updates auth.users on
  -- every sign-in (last_sign_in_at), and this trigger must stay out of the way
  -- of that or the demo could not log in at all.
  if new.encrypted_password is distinct from old.encrypted_password
     or new.email is distinct from old.email
  then
    if exists (
      select 1 from public.profiles p
      where p.id = old.id and p.is_demo
    ) then
      raise exception
        'The demo account is read-only; its credentials cannot be changed.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists protect_demo_credentials on auth.users;
create trigger protect_demo_credentials
  before update on auth.users
  for each row execute function public.protect_demo_credentials();
