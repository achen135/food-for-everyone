/**
 * The public read-only demo account (Spec §10 deploy checkpoint).
 *
 * These are meant to be public — `is_demo` restricts what the account can do
 * server-side (see `saveOrganizationAction` and the M6 write functions), not
 * the password. This is the one place the app and the README get them from;
 * `supabase/seed/demo-account.ts` imports the same two constants so the
 * account it creates always matches what's published here.
 *
 * No `server-only` import: the sign-in page passes these into a Client
 * Component to pre-fill the demo sign-in form.
 */
export const DEMO_EMAIL = "demo@foodforeveryone.invalid";
export const DEMO_PASSWORD = "see-the-map-2025";
