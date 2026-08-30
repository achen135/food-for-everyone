# CLAUDE.md — Food For Everyone

**Purpose.** Context brief for the coding agent (Claude Code). Terse, current-state-focused.
Everything here is a distillation of [`docs/Spec.md`](docs/Spec.md) — read that for full detail
and [`docs/Design Decisions.md`](docs/Design%20Decisions.md) for the rationale.

**This is the master copy**, edited in the Obsidian vault alongside planning. The build repo
is at `~/code/food-for-everyone` (outside the vault) and has its own copy of this file plus
`docs/`. Vault copy is source of truth; when planning changes, the changed doc is re-copied
into the repo.

---

## What this is

Web app connecting food **donors** (restaurants, grocers) with food **recipients** (food
banks, shelters) via a shared map. Organizations register, pick a type, set an address, and
see nearby counterparties with contact details. Ground-up rebuild of an old hackathon project
(`CirFin-Create`); nothing carried over but the concept.

## Constraints

- **Zero ongoing cost, no credit card on file.** Everything runs on free tiers: Vercel Hobby,
  Supabase free, OpenFreeMap tiles, Nominatim geocoding. Nothing that can auto-bill.

## Status

**M1 shipped** — PR #1 squash-merged to `main` (`34aaeb1`), tagged `v0.1-m1`, CI + Vercel
green. Auth (email/password + Google), `profiles` + `organizations` schema with RLS, `proxy.ts`
session gate, `lib/db` data layer, 28 tests. Supabase CLI is **linked** and the migration
history is in sync, so schema changes go through `supabase db push` — do not hand-apply SQL.
**Next: M2** — organization profile + geocoding. The build is a few-week sprint shipped in
small renditions; milestone order is in `docs/Spec.md` §7.1.

Carrying into M2 (from the M1 review, detail in `docs/Spec.md` §10):
- **Drop `profiles.organization_id`** in M2's migration, and remove it from `Profile` in
  `lib/db/types.ts`. Decision + reasoning in `docs/Design Decisions.md` (2026-08-29).
- `signUp` returns raw Supabase `error.message` — genericise it the way `signIn` does.
- `lib/supabase/middleware.ts` fails open (no-op) when Supabase env is missing; the production
  branch should fail loudly.

## Stack (decided)

- **Next.js** App Router + React + **TypeScript** (strict), hosted on Vercel Hobby
- **Tailwind CSS + shadcn/ui** (Radix primitives, components vendored into the repo)
- **Supabase**: Postgres + PostGIS + Auth + Row Level Security. Free tier, no card. Free
  projects pause after ~7 days idle. Anon key may ship to the client; service-role key is
  server-only, never imported into a client component.
  Auth methods: **email/password + Google OAuth**, both from v1.
- **MapLibre GL** via `react-map-gl/maplibre` + OpenFreeMap tiles (no key, no card).
  **Nominatim** (OSM) for address autocomplete / geocoding — attribution required.
- **react-hook-form + zod** for forms (zod schemas shared client/server)
- **sonner** for toasts (no `alert()`)
- **Vitest + React Testing Library**, **Playwright** for E2E
- CI: GitHub Actions (lint, typecheck, test, build) + Vercel preview deploys

## Architecture rules

- Browser never touches the database directly. All reads/writes go through Route Handlers /
  Server Actions that check the session and authorize the caller. RLS is defense-in-depth.
- Landing page is static/RSC. `/app/*` is auth-gated (middleware). Map is a client component.
  Map is auth-gated for v1 — see Design Decisions (sensitive shelter addresses + scraping).
- Map/API responses expose **org-level fields only** (name, type, address, contact, description).
  Never the registering person's `profiles.full_name` or their login email.
- Map query: `/api/orgs?type=…&near=lat,lng&radiusKm=…` → PostGIS `ST_DWithin`, scoped to the
  caller's counterparty type, returns GeoJSON.
- Address entry is **search-triggered geocoding, not keystroke autocomplete** (Nominatim
  policy): debounced "search address" action, one valid `User-Agent`, cache every result.
  Photon is the fallback. See Design Decisions.
- Keys in env vars. No map key needed. Supabase anon key may ship to the client; service-role
  key is server-only.

## Data model (draft)

- `organizations`: id, name, type (`donor`|`recipient`), description, email, phone, website,
  address, location `geography(Point,4326)`, verified, owner_id → auth.users, timestamps.
- `profiles` (1:1 auth user): id, full_name, created_at. **No `organization_id`** — the link
  is one-directional via `organizations.owner_id` (unique index = one org per account). See
  Design Decisions (2026-08-29); the column is dropped in M2's migration.
- Renames from old model: `businesses`→`organizations`, `donator`/`receiver`→`donor`/`recipient`.
- Coming in M6: `listings`, `claims` — don't hard-assume `organizations` is the only entity.

## Visual direction (see Spec §8)

Keep green, but demote it to an accent. Warm off-white bg, near-black text; green only for
buttons/links/highlights/tints, never body copy. Green ramp: `--brand #1F6E43` (deep pine,
AA on bg), `--brand-support #8DB580` (sage, tints only), `--accent #E8A33D` (amber, sparing).
Headings **Newsreader**, body **Public Sans** (both Google Fonts). lucide icons only.
Photography-forward hero/mission. No traction-stat band until real data. AA contrast, visible
focus rings, `prefers-reduced-motion` honored, motion short. Reference mockup: see
`design/` working files + the landing artifact linked in `docs/Sessions.md`.

## Milestones

M0 scaffold *(done)* · M1 auth + profile · M2 organization profile + geocoding · M3 map · M4
landing redesign + polish · M5 tests + hardening. Detail in `docs/Spec.md` §7.

**Sprint order (Spec §7.1):** M1 → M2 → M3 (+ seed script) → deploy checkpoint (+ Supabase
keep-alive cron + résumé-wording pass) → M6 → M4 (README GIF + read-only demo login) → M7
(write the measurement protocol first) → M8 (first to cut). M5 folds into every milestone.

## Post-v1 roadmap (résumé-driven — Spec §9)

M6 real-time donation requests (`listings` + `claims`, Supabase Realtime) ·
M7 performance layer (token-bucket rate limiter + read-through cache + committed k6 load-test
report) · M8 real-time analytics dashboard (Recharts + Realtime, seeded demo data).

**Build order:** finish M0–M5 before starting M6. Do not add features onto pre-refactor code.
**So the roadmap slots in cleanly, during M0–M5:** route all DB access through a thin data
layer that can be instrumented for read-count benchmarking (M7); structure API route handlers
so a rate-limit wrapper drops in without rewrites (M7). Each M6–M8 milestone commits evidence
(k6 output, seed script, screenshots); seeded data is called seeded, never real traffic.

## What's done / what's not

- [x] M0 scaffold — Next 16 / React 19 / TS strict / Tailwind v4 / shadcn; Spec §8 tokens +
  Newsreader/Public Sans wired in; Vitest + RTL (5 tests); CI (format → lint → typecheck →
  test → build).
- [x] GitHub repo, Vercel project, Supabase project created (2026-08-28).
- [x] Landing mockup approved (`docs/design-reference/`).
- [x] M1 — auth (email/password + Google OAuth), `profiles` + `organizations` schema, RLS
  policies, protected `/app` route group, profile creation on first login. *(merged + tagged
  `v0.1-m1`, 2026-08-29; review fixed an open redirect in `safeRedirectPath()`)*

## Working agreement

- **One PR + one tag (`v0.x-mN`) per milestone.** Work on a branch; keep `main` green and
  deployed. A separate agent handles the git commits.
- Keep `docs/Sessions.md` updated as work happens (newest entry on top). Each milestone entry
  includes a plain-English **"How this code works"** walkthrough of what was added — written
  for Alex to learn from, not just a changelog.
- Maintain two learning docs as the code grows:
  - `docs/Architecture.md` — a living map of the codebase (folders, request lifecycle, where
    auth / RLS / geo live, what each key module does). Update the affected sections every
    milestone.
  - `docs/Concepts.md` — an append-only glossary: each framework / DB concept the code uses
    (RSC vs client components, middleware, Supabase SSR session, RLS, PostGIS `ST_DWithin`,
    Realtime channels, …), explained plainly, with a pointer to where it's used in the repo.
- When an open question is resolved, record the reasoning in `docs/Design Decisions.md` and
  clear it from Spec §10.
- Tests are per-milestone (zod/RTL + a Playwright happy-path + an RLS review), not a final phase.
