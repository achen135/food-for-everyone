# Food For Everyone — Architecture

> A living map of the codebase, kept current as the build progresses. The goal is that Alex
> can open this file and understand how the running app fits together without reading every
> source file. The coding agent updates the affected sections at the end of each milestone.
>
> Companion docs: [`Spec.md`](Spec.md) (what/why at the design level),
> [`Design Decisions.md`](Design%20Decisions.md) (why each choice), [`Concepts.md`](Concepts.md)
> (plain-English explainer of each framework/DB concept used here).

---

## How to read this doc

Each section answers one question:

1. **Folder layout** — where things live and why.
2. **Request lifecycle** — what happens between a click and a response.
3. **Auth & authorization** — who is allowed to do what, enforced where.
4. **Data layer** — how code talks to Postgres.
5. **The map** — how organization pins get on screen.
6. **Config files** — what each dotfile in the repo root is for.
7. **Build & CI** — how the app is checked and deployed.

Sections are marked **[current]** (true of the code today) or **[planned: Mx]** (the shape
it will take at milestone x, not built yet).

---

## 1. Folder layout **[current: M2]**

```
app/                 Next.js App Router. Each folder = a route segment.
  layout.tsx         Root layout — <html>/<body>, fonts, metadata, <Toaster/>.
  page.tsx           "/" — placeholder landing (real one is M4).
  globals.css        Tailwind v4 entry + design tokens (Spec §8), light + dark.
  (auth)/            Route group (no URL segment) — unauthenticated pages.
    layout.tsx       Centered card; bounces signed-in users to /app.
    actions.ts       "use server" — signIn / signUp / signOut.
    sign-in/ sign-up/ verify-email/
  auth/              Literal /auth/* — OAuth + email return endpoints.
    callback/route.ts    exchangeCodeForSession (OAuth / PKCE).
    confirm/route.ts     verifyOtp (email token_hash).
    auth-code-error/     shown when a link is bad/expired.
  app/               Literal /app/* — authenticated area (gated by proxy.ts).
    layout.tsx       Server session re-check + ensure profile + nav shell.
    page.tsx         Dashboard — org summary card, or a "set up" CTA.
    organization/
      page.tsx       Create/edit form (loads the caller's org).
      actions.ts     "use server" — searchAddressAction, saveOrganizationAction.
components/
  ui/                shadcn, vendored: button, card, input, label, form, sonner,
                     textarea, radio-group, dialog, badge.
  auth/              sign-in-form, sign-up-form, google-button (client).
  organization/      organization-form, address-search-dialog (client).
lib/
  env.ts             Lazy env accessors (never throw at import time).
  utils.ts           cn() — className merge helper.
  geocode.ts         server-only. Nominatim /search, unstable_cache-wrapped.
  auth/redirect.ts   safeRedirectPath() — same-origin redirect guard.
  supabase/          client.ts (browser), server.ts (per-request), middleware.ts
                     (updateSession helper used by proxy.ts).
  db/                The instrumented data-access layer (see §4).
    index.ts         Public barrel — callers import from here.
    instrument.ts    tracked() read counter (M7 seam).
    profiles.ts      getMyProfile, getOrCreateProfile.
    organizations.ts getMyOrganization, upsertMyOrganization.
    types.ts         Hand-written row types (generated types come later).
  validation/        auth.ts, organization.ts — zod, shared client + server.
proxy.ts             Session refresh + gate /app/* (Next 16's renamed
                     "middleware" convention).
supabase/
  config.toml        Supabase CLI config (linked to project pdgbtkplzfocxyuflpxm).
  migrations/        20260828223018_init.sql (M1),
                     20260829041111_organization_profile.sql (M2).
docs/                This planning set (mirrored from the Obsidian vault).
.github/workflows/   CI.
```

**[planned]** as later milestones land:

```
app/
  (marketing)/       route group — public landing [M4]
  app/map/           the map page [M3]
  api/
    health/route.ts  cheap endpoint for the keep-alive cron [deploy checkpoint]
    orgs/route.ts    GET counterparties near a point (GeoJSON) [M3]
    listings/…       donation listings + claims [M6]
supabase/
  migrations/…            widen organizations RLS for the map [M3]
  seed.ts                 ~25–30 demo orgs across one metro [M3], + analytics [M8]
```

## 2. Request lifecycle

**[current: M2]**

- **Every request** hits `proxy.ts` first (Next runs it on the matched paths).
  It calls `updateSession()`: builds a request-bound Supabase server client,
  calls `auth.getUser()` (validates the JWT with Supabase, not just a decode),
  writes any refreshed auth cookie onto the response, and redirects logged-out
  `/app/*` requests to `/sign-in`. If Supabase env is unset it logs once and
  passes through.
- **Landing "/"** is a static RSC — no JS, no session read.
- **Auth pages** are dynamic RSCs under `app/(auth)/layout.tsx`, which reads the
  session and redirects to `/app` if you're already in. Forms are Client
  Components (`react-hook-form` + zod).
- **Auth mutation:** form → Server Action in `app/(auth)/actions.ts` → re-parse
  shared zod schema → `supabase.auth.*` sets/clears the cookie → `redirect()`.
- **OAuth / email return:** `app/auth/callback` / `app/auth/confirm` Route
  Handlers turn the `code` / `token_hash` into a session cookie, then redirect.
- **Authenticated page:** `app/app/layout.tsx` re-checks the session, calls
  `getOrCreateProfile()`, renders the nav shell.
- **Address search (M2):** the "Search address" button in the org form calls
  `searchAddressAction` (Server Action) → `geocodeAddress()` → Nominatim
  `/search`, wrapped in `unstable_cache` so a repeat query never re-hits it.
  Never fires on keystroke (Nominatim policy — see Design Decisions). Results
  come back to the client; picking one sets `address` + `latitude`/`longitude`
  in form state.
- **Organization write (M2):** form → `saveOrganizationAction` → re-parse the
  shared `organizationSchema` → `upsertMyOrganization()` (through `lib/db`,
  `onConflict: owner_id`) → RLS `organizations_*_own` is the second check →
  `revalidatePath` → the action returns `{ ok: true }` and the client toasts +
  `router.push("/app")`. (Contrast the auth actions, which `redirect()`
  server-side — here we return data so the client can toast first.)

**[planned]** Map data read [M3]: browser → `GET /api/orgs?...` (Route Handler)
→ session check → one PostGIS query through `lib/db` → GeoJSON → client map.
The browser never holds a DB credential.

## 3. Auth & authorization **[current: M2]**

- **Authentication** (who you are): Supabase Auth — email/password **and** Google
  OAuth. The session is a cookie, read on the server via `@supabase/ssr`
  (`lib/supabase/server.ts`). `proxy.ts` refreshes it every request and gates
  `/app/*`.
- **Authorization** (what you may do), three layers:
  1. `proxy.ts` — coarse: is there a user, for `/app/*`.
  2. Server Action / Route Handler / `app/app/layout.tsx` — server re-check
    before rendering or mutating (fail fast, good errors).
  3. **Row Level Security** on every table — `auth.uid() = <owner column>`.
    Even a wrong query returns zero rows. Policies: `profiles` own-row only;
    `organizations` own-row only for `select/insert/update/delete` (M3 widens
    SELECT for the map). `organizations.owner_id` also defaults to `auth.uid()`
    (M2) so a write that omits it can't create a mis-owned row.
- **M2 schema note:** `profiles.organization_id` was **dropped** (M2 migration).
  It duplicated `organizations.owner_id` and was writable to any UUID under
  `profiles_update_own`. One org per account is enforced by the unique index on
  `organizations.owner_id` — see Design Decisions, 2026-08-29.
- **Data minimisation:** whatever reads organizations for the map (M3) will
  select org-level columns only (name, type, address, contact, description) —
  never `profiles.full_name` or the registrant's login email.
- **Signup → profile:** a `security definer` trigger on `auth.users`
  (`handle_new_user`) creates the `profiles` row; `getOrCreateProfile()` is the
  app-side backstop (handles "trigger not installed yet" and the insert race).

## 4. Data layer **[current: M2]**

`lib/db/` is the only place that runs queries. Callers import the barrel
(`@/lib/db`), never `@/lib/supabase/server` directly. Every operation is wrapped
in `tracked(label, () => query)` (`lib/db/instrument.ts`), which today just
increments a process-local read counter and is the single seam where M7 hangs
timing and a read-through cache — no call site changes.

Functions: `getMyProfile()`, `getOrCreateProfile(user)` (profiles);
`getMyOrganization()`, `upsertMyOrganization(userId, fields)` (organizations).
The upsert keys on `owner_id` (one org per account). `location` is written as a
WKT string `POINT(lng lat)` which PostgREST casts to `geography(Point,4326)`;
when the form didn't re-search the address, `latitude`/`longitude` come through
as `null` and `location` is left out of the write so the stored point survives.

Row types are hand-written in `lib/db/types.ts`; `supabase gen types` output
replaces them once the schema settles.

## 5. Geocoding **[current: M2]** / The map **[planned: M3]**

- **Geocoding (M2):** `lib/geocode.ts` (`server-only`). `geocodeAddress(query)`
  normalizes the query, short-circuits anything under 3 chars, then calls
  `fetchGeocodeResults` wrapped in `unstable_cache` (30-day TTL, tag `geocode`).
  `fetchGeocodeResults` hits Nominatim `/search?format=jsonv2` with a real
  `User-Agent` and maps `{display_name,lat,lon}` → `{label,latitude,longitude}`.
  Only ever called from `searchAddressAction` — never per-keystroke (Nominatim
  policy, Design Decisions). Photon is the documented fallback. The
  Postgres-backed read-through cache is an M7 deliverable, not this.
- **The map (M3):** `react-map-gl/maplibre` + OpenFreeMap tiles (no key). The
  map page gets browser geolocation, calls `/api/orgs` with a centre + radius;
  the handler runs `ST_DWithin` scoped to the caller's counterparty type and
  returns a GeoJSON `FeatureCollection`; `react-map-gl` renders it clustered,
  pin click → contact popup.

## 6. Config files **[current: M1]**

| File | Purpose |
|---|---|
| `next.config.ts` | Next config. `agentRules: false` stops `next dev` from appending an agent-rules block to `CLAUDE.md` (the vault master). |
| `tsconfig.json` | TS strict; `@/*` path alias → repo root. |
| `eslint.config.mjs` | ESLint 9 flat config (`eslint-config-next` + Prettier compat). |
| `.prettierrc.json` / `.prettierignore` | Prettier + Tailwind class sorting; `docs/` and `CLAUDE.md` excluded (Obsidian-authored). |
| `vitest.config.mts` | Vitest + jsdom + RTL. `.mts` so it loads as ESM; `resolve.tsconfigPaths: true` for `@/*`. |
| `vitest.setup.ts` | jest-dom matchers + jsdom polyfills Radix needs (`ResizeObserver`, `matchMedia`, pointer-capture). |
| `components.json` | shadcn config (style `radix-nova`, lucide icons, aliases). |
| `postcss.config.mjs` | Tailwind v4 PostCSS plugin. |
| `.nvmrc` | Node version for local + CI. |
| `.env.example` | Env var names — `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (unused yet), `NEXT_PUBLIC_SITE_URL`. Copy to `.env.local`. |
| `.prettierignore` | Excludes `docs/`, `CLAUDE.md` (Obsidian-authored), and `supabase/.temp/` (CLI local state). |
| `proxy.ts` | Next 16 "middleware" convention (renamed). Session refresh + `/app/*` gate. |
| `supabase/config.toml` | Supabase CLI config; linked to project `pdgbtkplzfocxyuflpxm`. `supabase db push` applies `migrations/*`. |

## 7. Build & CI **[current: M2]**

`.github/workflows/ci.yml` runs on push to `main` and every PR:
`npm ci` → Prettier check → ESLint → `next typegen && tsc --noEmit` → Vitest → `next build`.

The `build` step sets placeholder `NEXT_PUBLIC_SUPABASE_*` env. Combined with lazy
env access (`lib/env.ts` reads `process.env` only inside functions) and dynamic
auth routes, `next build` makes no network call and needs no real credentials.

Milestone workflow (from M1): branch `mN/<slug>` → PR → squash-merge → tag
`v0.x-mN`; `main` stays green and Vercel-deployable. Commits are made by a
separate git agent.

---

## Change log

- **2026-08-29** — M2. Organization create/edit (`/app/organization`),
  search-triggered Nominatim geocoding (`lib/geocode.ts`), `lib/db/organizations.ts`,
  `lib/validation/organization.ts`, dashboard org summary. Migration
  `20260829041111` drops `profiles.organization_id`, defaults `owner_id` to
  `auth.uid()`, adds length CHECKs. `signUp` error genericised. Sections 1–7
  updated to `[current: M2]`.
- **2026-08-28** — M1. Auth (email/password + Google), `profiles` + `organizations`
  schema with RLS, `proxy.ts` session gate, `lib/supabase/*`, `lib/db/*` data
  layer, `lib/validation/auth.ts`. Sections 1–4, 6, 7 updated to `[current: M1]`.
- **2026-08-28** — created. Reflects the M0 scaffold; planned sections seeded from Spec §5.
