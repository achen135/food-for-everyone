# Food For Everyone

Connects food donors (restaurants, grocers, farms) with food recipients (food banks,
shelters, community fridges) through a shared map. Ground-up rebuild of an earlier
hackathon project.

**Status:** shipped so far — authentication (email/password + Google), organization
profiles with search-triggered geocoding, a clustered MapLibre map of nearby
counterparties backed by a PostGIS radius query, real-time donation listings (donors
post surplus, recipients claim it, both sides update live), and a redesigned landing
page. Try it without an account — see **Live demo** below.

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
npm run db:seed             # add any missing demo organizations
npm run db:seed -- --reset  # delete the seed accounts first, then recreate
```

Creates 30 fictional organizations at real Chicago-area addresses, plus the read-only
demo account above, so the map and the radius query have something to show. Needs
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

## Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Dev server (Turbopack)                          |
| `npm run build`     | Production build                                |
| `npm start`         | Serve the production build                      |
| `npm run lint`      | ESLint (`eslint-config-next` + Prettier compat) |
| `npm run typecheck` | `next typegen` then `tsc --noEmit`              |
| `npm run test`      | Vitest (jsdom + React Testing Library)          |
| `npm run format`    | Prettier write                                  |
| `npm run db:push`   | Apply pending migrations to the linked project  |
| `npm run db:seed`   | Create the demo organizations + demo account    |

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, test, and build on
every push to `main` and every pull request.
