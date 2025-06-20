# Food For Everyone

Connects food donors (restaurants, grocers, farms) with food recipients (food banks,
shelters, community fridges) through a shared map. Ground-up rebuild of an earlier
hackathon project.

**Status:** shipped so far — authentication (email/password + Google), organization
profiles with search-triggered geocoding, a clustered MapLibre map of nearby
counterparties backed by a PostGIS radius query, real-time donation listings (donors
post surplus, recipients claim it, both sides update live), a redesigned landing page,
and a live-updating analytics dashboard. Try it without an account — see **Live demo**
below.

## Live demo

**→ [food-for-everyone-app.vercel.app](https://food-for-everyone-app.vercel.app)**

The map and listings are auth-gated. The demo account gets past that in one click:
**[open the demo sign-in](https://food-for-everyone-app.vercel.app/sign-in?demo=1)** —
the credentials below are pre-filled, just press "Sign in".

|          |                                |
| -------- | ------------------------------ |
| Email    | `demo@foodforeveryone.invalid` |
| Password | `see-the-map-2025`             |

It's a real account against a seeded Chicago dataset (~30 organizations) and it's
**read-only** — the restriction is enforced in the database with Row Level Security, not
just in the UI, because the password above is public.

## Analytics

`/app/analytics` shows donations over time, fulfilment rate, active listings, and how far
food travels between donor and recipient — updating live from one Supabase Realtime
subscription. Every figure is aggregated in Postgres by a `security definer` function
with an explicit return shape; nothing pulls rows to the client to count them, because
Row Level Security would make a client-side "network total" silently a per-caller total.

**The numbers on that page are seeded demo data, not real donation traffic.** The
dashboard says so on the page itself. `npm run db:seed` generates them, and on the run
recorded in the dev log it produced **263 listings and 194 claims** across 90 days —
154 completed, 34 cancelled, 62 expired unclaimed, 13 still live. That works out to a
61.6% network fulfilment rate. The generator is a pure function over a seeded PRNG
(`supabase/seed/activity.ts`), so those proportions are re-derivable by running it; the
total moves by a handful of rows depending on which weekdays the 90-day window covers.

## Performance

`/api/orgs` sits behind an in-process token-bucket rate limiter and a read-through cache
(TTL + stale-while-revalidate + single-flight). A local k6 run (4 VUs against local
Postgres) measured the cache removing **~99% of database reads** on the map query;
end-to-end latency did not move, because that endpoint is bound by auth round-trips
rather than by the database. Full protocol, numbers, and caveats are in
[`docs/benchmarks/`](docs/benchmarks).

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind v4 + shadcn/ui · Supabase
(Postgres + PostGIS + Auth + RLS) · MapLibre GL + OpenFreeMap · deployed on Vercel.
Everything on free, no-card tiers.

## Getting started

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
cp .env.example .env.local   # then fill in the Supabase values
npm run dev        # http://localhost:3000
```

The static landing page runs without any env. The auth pages and `/app` need
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase →
Project Settings → API).

### Running against a local database

`.env.local` points at the deployed Supabase project, so a plain `npm run dev`
runs your local code **against production**. That is usually what you want — but
not when you are working on a branch whose migration production hasn't got. The
symptom is a PostgREST `PGRST202: Could not find the function ...`, which looks
nothing like "wrong database".

```bash
npx supabase start        # needs Docker Desktop running
npm run db:reset:local    # local only — `db:push` targets PRODUCTION
npm run db:seed:local     # organizations, demo account, ~90 days of activity
npm run dev:local         # dev server wired to the local stack
```

`dev:local` reads the local URL and keys from `supabase status` (so they cannot
go stale), prepends Docker Desktop's `~/.docker/bin` to `PATH` if the `docker`
CLI isn't there, and leaves `.env.local` untouched — Next gives an existing
environment variable precedence over a `.env` file. Stop any `npm run dev`
already running first: Next allows one dev server per project directory.

### Database

Apply the schema + RLS to your Supabase project:

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push   # or paste supabase/migrations/*.sql into the Supabase SQL editor
```

For Google sign-in, configure the Google provider in Supabase → Authentication →
Providers, and add `http://localhost:3000/**` plus your production URL to the allowed
Redirect URLs.

### Demo data

```bash
npm run db:seed                     # add any missing demo orgs + their history
npm run db:seed -- --reset          # delete the seed accounts first, then recreate
npm run db:seed -- --reset-activity # regenerate listings/claims only
```

Creates 30 fictional organizations at real Chicago-area addresses, plus the read-only
demo account above, plus ~90 days of listings and claims so the map, the radius query,
and the dashboard all have something to show. Needs `SUPABASE_SERVICE_ROLE_KEY` in
`.env.local`.

Everything it writes is scoped to accounts on the reserved `.invalid` seed domain (and
the demo organization), so it cannot disturb a real account. It prints its target URL
first, and warns when that target is not localhost — `.env.local` normally points at the
linked production project.

## Scripts

| Script                   | What it does                                    |
| ------------------------ | ----------------------------------------------- |
| `npm run dev`            | Dev server (Turbopack)                          |
| `npm run build`          | Production build                                |
| `npm start`              | Serve the production build                      |
| `npm run lint`           | ESLint (`eslint-config-next` + Prettier compat) |
| `npm run typecheck`      | `next typegen` then `tsc --noEmit`              |
| `npm run test`           | Vitest (jsdom + React Testing Library)          |
| `npm run format`         | Prettier write                                  |
| `npm run dev:local`      | Dev server against the local Supabase stack     |
| `npm run db:push`        | Apply pending migrations to the linked project  |
| `npm run db:seed`        | Create the demo organizations, account, history |
| `npm run db:seed:local`  | The same, against the local stack               |
| `npm run db:reset:local` | Rebuild the local database from migrations      |

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, test, and build on
every push to `main` and every pull request.
