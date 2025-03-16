# Food For Everyone

Connects food donors (restaurants, grocers, farms) with food recipients (food banks,
shelters, community fridges) through a shared map. Ground-up rebuild of an earlier
hackathon project.

**Status:** M1 in progress on branch `m1/auth-and-profile` — email/password + Google auth,
`profiles` + `organizations` schema with RLS, protected `/app`. Organization profiles (M2)
and the map (M3) are next; the landing page is redesigned in M4.

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
npx supabase db push
```

(or paste `supabase/migrations/*.sql` into the Supabase SQL editor).

For Google sign-in, configure the Google provider in Supabase → Authentication →
Providers, and add `http://localhost:3000/**` plus your production URL to the
allowed Redirect URLs.

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

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, test, and build on
every push to `main` and every pull request.
