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

The map and listings are auth-gated, so a bare URL shows a visitor nothing on its own.
The demo account gets past that in one click: `/sign-in?demo=1` on any deployment of
this app pre-fills the credentials below — just press "Sign in".

|          |                                |
| -------- | ------------------------------ |
| Email    | `demo@foodforeveryone.invalid` |
| Password | `see-the-map-2025`             |

It's a real account against the seeded Chicago dataset (~30 organizations) — **read-only**,
enforced server-side rather than by hiding buttons: posting, claiming, and profile edits
all return "This is a read-only demo account." The app labels it the same way, so it's
never mistaken for a real listing on the map.

> **No public link yet.** Vercel Deployment Protection is currently on, so every
> production URL redirects to a Vercel SSO login instead of the app — and
> `food-for-everyone.vercel.app` isn't this project's domain (it resolves elsewhere).
> Both are dashboard settings (Project → Settings → Deployment Protection; Settings →
> Domains), not code. Until they're sorted, `npm run dev` plus the credentials above is
> the working path — see **Getting started** below.

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
npm run db:push
```

(or paste `supabase/migrations/*.sql` into the Supabase SQL editor).

Check it landed — the version must appear in **both** columns:

```bash
npx supabase migration list
```

For Google sign-in, configure the Google provider in Supabase → Authentication →
Providers, and add `http://localhost:3000/**` plus your production URL to the
allowed Redirect URLs.

### Demo data

```bash
npm run db:seed             # add any missing demo organizations
npm run db:seed -- --reset  # delete the seed accounts first, then recreate
```

Creates 30 fictional organizations at real Chicago-area addresses, plus the read-only
demo account above, so the map and the radius query have something to show. Needs
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

The 30 organizations each get an `@seed.foodforeveryone.invalid` email, and the script
only ever touches accounts on that domain (plus the one demo account, by its exact
address) — it cannot disturb a real one. Sign in as the demo account to browse them
immediately, or sign in as a normal user with a Chicago address of your own.

**This is seeded demo data.** If it ever backs a figure in a write-up, it gets described
as seeded — never as real usage.

## Scripts

| Script                     | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`              | Dev server (Turbopack)                                                               |
| `npm run build`            | Production build                                                                     |
| `npm start`                | Serve the production build                                                           |
| `npm run lint`             | ESLint (`eslint-config-next` + Prettier compat)                                      |
| `npm run typecheck`        | `next typegen` then `tsc --noEmit`                                                   |
| `npm run test`             | Vitest (jsdom + React Testing Library), one run                                      |
| `npm run test:watch`       | Vitest in watch mode                                                                 |
| `npm run format`           | Prettier write                                                                       |
| `npm run format:check`     | Prettier check (used in CI)                                                          |
| `npm run check:client-env` | Verifies `NEXT_PUBLIC_*` reached the built client bundle (used in CI, after `build`) |
| `npm run db:push`          | Apply pending migrations to the linked project                                       |
| `npm run db:seed`          | Create the demo organizations + demo account (service role)                          |

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, test, and build on
every push to `main` and every pull request.
