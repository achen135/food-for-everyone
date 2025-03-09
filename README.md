# Food For Everyone

Connects food donors (restaurants, grocers, farms) with food recipients (food banks,
shelters, community fridges) through a shared map. Ground-up rebuild of an earlier
hackathon project.

**Status:** M0 scaffold complete. Auth (M1), organization profiles (M2), and the map (M3)
are next; the landing page is redesigned in M4.

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind v4 + shadcn/ui · Supabase
(Postgres + PostGIS + Auth + RLS) · MapLibre GL + OpenFreeMap · deployed on Vercel.
Everything on free, no-card tiers.

## Getting started

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
cp .env.example .env.local   # not needed until M1
npm run dev        # http://localhost:3000
```

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
