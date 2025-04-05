# Food For Everyone

Connects food donors (restaurants, grocers, farms) with food recipients (food banks,
shelters, community fridges) through a shared map. Ground-up rebuild of an earlier
hackathon project.

**Status:** shipped so far — authentication (email/password + Google), organization
profiles with search-triggered geocoding, and a clustered MapLibre map of nearby
counterparties backed by a PostGIS radius query, plus a seed script. The landing page
redesign is next up.

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

Creates 30 fictional organizations at real Chicago-area addresses so the map and the
radius query have something to show. Needs `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

Every account it creates has an `@seed.foodforeveryone.invalid` email, and the script
only ever touches accounts on that domain — it cannot disturb a real one. To browse the
seeded map, sign in as a normal user and give your own organization a Chicago address;
donors will see the seeded recipients and vice versa.

**This is seeded demo data.** If it ever backs a figure in a write-up, it gets described
as seeded — never as real usage.

## Scripts

| Script                 | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | Dev server (Turbopack)                          |
| `npm run build`        | Production build                                |
| `npm start`            | Serve the production build                      |
| `npm run lint`         | ESLint (`eslint-config-next` + Prettier compat) |
| `npm run typecheck`    | `next typegen` then `tsc --noEmit`              |
| `npm run test`         | Vitest (jsdom + React Testing Library), one run |
| `npm run test:watch`   | Vitest in watch mode                            |
| `npm run format`       | Prettier write                                  |
| `npm run format:check` | Prettier check (used in CI)                     |
| `npm run db:push`      | Apply pending migrations to the linked project  |
| `npm run db:seed`      | Create the demo organizations (service role)    |

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, test, and build on
every push to `main` and every pull request.
