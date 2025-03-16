# Food For Everyone — Sessions (Dev Log)

> Chronological log of work: features implemented, bugs found and fixed, blockers, decisions
> made mid-build. Newest entry on top.

**Entry format**

## YYYY-MM-DD — <short title>
- **Did:** what changed
- **Problem / fix:** if debugging, the symptom and the root cause
- **Notes:** anything worth remembering later
- **Next:** what's queued

---

## 2026-08-28 — M1 review + fixes

Review pass over `m1/auth-and-profile` (commit `7d7c3a2`) before opening the PR. Baseline was
green: typecheck, lint, 26 tests, `next build`, `.env.local` ignored, no secrets tracked.

- **Problem / fix — open redirect in `safeRedirectPath()`.** The guard rejected `//evil.com`
  but not `/\evil.com`. Per the WHATWG URL spec a leading `/\` enters *special authority ignore
  slashes* state, so what follows is parsed as a hostname —
  `new URL("/\evil.com", "https://myapp.com/sign-in")` resolves to `https://evil.com/`.
  Reachable because `signIn` calls `redirect()` with a **relative** path and the browser
  resolves the relative `Location`. Chain: `/sign-in?redirectTo=/\evil.com` → victim enters
  real credentials → forwarded off-site. Fixed by rejecting backslashes and control characters;
  2 regression tests added (28 total). The auth Route Handlers were never vulnerable — they
  concatenate into an absolute URL first, pinning the host — but incidentally, not by design.
  Full reasoning in `Design Decisions.md`.
- **Did:** `set_updated_at` gets `set search_path = ''` + `pg_catalog.now()`, matching
  `handle_new_user` and clearing Supabase's `function_search_path_mutable` advisor. Applied to
  the live project by hand; verified via `pg_proc.proconfig`.
- **Did:** moved `shadcn` (codegen CLI) from `dependencies` to `devDependencies`; lockfile
  re-synced with `npm install --package-lock-only`.
- **Notes — deferred, tracked in Spec §10:** `profiles.organization_id` writable to any org
  UUID (fix by dropping the column in M2, not patching the policy); `signUp` returns raw
  Supabase error text (enumeration); proxy fails open if Supabase env is missing in production.
- **Notes:** Supabase CLI not linked here, so `_init.sql` was hand-applied and can drift from
  the live DB. Editing a migration does not re-run it. Link + `migration repair` before M2.
- **Next:** PR, squash-merge, tag `v0.1-m1`; link the Supabase CLI; then M2.

## 2026-08-28 — M1: auth + profile

Branch `m1/auth-and-profile`. Commits handled by the git agent (one PR + tag `v0.1-m1`).

- **Did — schema (`supabase/migrations/20260828223018_init.sql`):**
  - `postgis` extension; `organization_type` enum (`donor` | `recipient`).
  - `organizations` table (owner_id → auth.users, name/type/contact/address,
    `geography(Point,4326)` location, `verified`, timestamps). Unique index on
    `owner_id` (one org per account for v1), GiST index on `location`, index on
    `type`. `updated_at` maintained by a `set_updated_at` trigger.
  - `profiles` table (id → auth.users, `full_name`, `organization_id`, created_at).
  - `handle_new_user()` — `security definer` trigger on `auth.users` insert that
    creates the matching `profiles` row, copying `full_name` from signup metadata.
  - **RLS on both tables.** `profiles`: select/insert/update only your own row.
    `organizations` (M1): select/insert/update/delete only your own. M3's
    migration widens `organizations` SELECT so counterparties can see each other.
- **Did — Supabase client layer (`lib/supabase/`):**
  - `client.ts` browser client, `server.ts` per-request server client (cookie
    read/write via `@supabase/ssr`), `middleware.ts` `updateSession()` helper.
  - `proxy.ts` at the repo root (Next 16 renamed the `middleware` file
    convention to `proxy`) refreshes the session cookie on every request and
    redirects unauthenticated `/app/*` hits to `/sign-in?redirectTo=…`.
  - If `NEXT_PUBLIC_SUPABASE_*` is unset the proxy logs once and no-ops, so the
    static landing page still runs; the auth pages themselves error with a
    "copy .env.example" message (they genuinely need the backend).
- **Did — data layer (`lib/db/`):** every query goes through `tracked()`
  (`instrument.ts`) which counts reads now and is the single seam for the M7
  cache/latency work. `profiles.ts`: `getMyProfile()`, `getOrCreateProfile()`
  (app-side backstop for the trigger, handles the 23505 race). `index.ts` is the
  public barrel — callers import `@/lib/db`, never `@/lib/supabase/server`.
- **Did — auth UI + flows:**
  - `app/(auth)/` route group: `/sign-in`, `/sign-up`, `/verify-email`, shared
    `layout.tsx` that bounces signed-in users to `/app`.
  - Server Actions (`app/(auth)/actions.ts`): `signIn`, `signUp`, `signOut` —
    each re-validates with the shared zod schema before calling Supabase.
  - Route Handlers `app/auth/callback/route.ts` (OAuth/PKCE code exchange) and
    `app/auth/confirm/route.ts` (email `token_hash` verify); `auth-code-error`
    page for failures.
  - `react-hook-form` + `zodResolver` client forms (`components/auth/`), shadcn
    `Form`/`Input`/`Card`, `sonner` `<Toaster/>` mounted in the root layout.
    Google button calls `signInWithOAuth({ provider: "google" })`.
  - `zod` schemas in `lib/validation/auth.ts`, shared client + server.
  - `/app` route group: `app/app/layout.tsx` re-checks the session server-side,
    guarantees a profile row, renders the signed-in shell (name + sign-out);
    `app/app/page.tsx` is a placeholder dashboard.
- **Did — CI / tooling:** `build` step got placeholder `NEXT_PUBLIC_SUPABASE_*`
  env (Spec §10). Added deps: `@supabase/supabase-js`, `@supabase/ssr`,
  `react-hook-form`, `zod`, `@hookform/resolvers`, `sonner`, `next-themes` (via
  the sonner component), `supabase` CLI (dev). shadcn: `input`, `label`, `card`,
  `sonner`, plus a hand-added `form.tsx` (the `radix-nova` registry ships an
  empty `form` item). 26 unit tests pass (schemas, `safeRedirectPath`,
  `tracked`, `SignInForm` RTL). `format` / `lint` / `typecheck` / `test` /
  `build` all green locally with no `.env.local`.
- **Problem / fix:**
  - `next build` warned `the "middleware" file convention is deprecated, use
    "proxy"` (Next 16.3). Renamed `middleware.ts` → `proxy.ts`, `middleware()`
    → `proxy()`. `config.matcher` unchanged.
  - shadcn `radix-nova` preset has no real `form` component — wrote the standard
    shadcn `components/ui/form.tsx` by hand (deps: react-hook-form, radix Slot).
  - `sonner.tsx` pulls `next-themes`; shadcn installed it. No `ThemeProvider`
    yet (dark-mode pass is M4); `useTheme()` returns undefined and the component
    falls back to `"system"`, which is fine.

### How this code works (walkthrough for Alex)

**The session is a cookie, and three places read it.**
1. `proxy.ts` runs first, on every request. It calls `updateSession()`, which
   builds a server Supabase client bound to the request/response cookies, calls
   `supabase.auth.getUser()` (this pings Supabase to *validate* the JWT, not just
   decode it), and — because Server Components can't write cookies — copies any
   refreshed auth cookie onto the response. It also does the coarse gate: no user
   + path under `/app` ⇒ redirect to `/sign-in`.
2. `app/app/layout.tsx` (a Server Component) re-reads the session with its own
   server client and redirects if it's missing. Belt and suspenders: even if the
   matcher missed something, the page won't render for a logged-out user.
3. RLS in Postgres is the last line: every policy is `auth.uid() = <owner col>`,
   so even a bug that sent a query for someone else's row returns nothing.

**Signing up.** `SignUpForm` (client) validates with zod, then calls the
`signUp` Server Action. The action re-parses the same schema, then
`supabase.auth.signUp({ email, password, options: { data: { full_name },
emailRedirectTo: ".../auth/confirm?next=/app" } })`. Supabase stores the user
as *unconfirmed* and emails a link. Two things then happen server-side:
the `handle_new_user` trigger inserts a `profiles` row (copying `full_name` out
of the signup metadata); and the action redirects the browser to
`/verify-email`. When the user clicks the email link they land on
`/auth/confirm`, which calls `verifyOtp({ token_hash, type })` — that sets the
session cookie and forwards to `/app`.

**Signing in.** `SignInForm` → `signIn` action → `signInWithPassword`. On
success the cookie is set during the action and we `redirect("/app")`
(or back to `redirectTo`, run through `safeRedirectPath` so it can't be an
off-site URL).

**Google.** The client button calls `signInWithOAuth`. The browser bounces to
Google and back to `/auth/callback?code=…`; the handler does
`exchangeCodeForSession(code)` (PKCE) to set the cookie, then redirects to
`next`. No `profiles` metadata from us, so `getOrCreateProfile` fills
`full_name` from Google's `user_metadata` if the trigger didn't.

**Profiles, defensively.** `app/app/layout.tsx` calls `getOrCreateProfile(user)`:
select the row; if absent (trigger not installed yet, or lost a race), insert it;
if the insert hits a duplicate-key error, the trigger beat us — just re-select.
Every one of these calls is wrapped in `tracked()` so M7 can count reads without
touching this file.

**Why the app boots without Supabase env.** `lib/env.ts` reads `process.env`
inside functions, never at import time, so `next build` and CI don't need real
values. The proxy checks for the vars and no-ops if they're missing. Only the
pages that actually talk to Supabase fail, and they fail with a message that
tells you to copy `.env.example`.

### Needs Alex (can't be done from the repo)

1. **Apply the migration.** `supabase link --project-ref <ref>` then
   `supabase db push` — or paste `supabase/migrations/20260828223018_init.sql`
   into the SQL editor. (The `auth.users` trigger needs to run as `postgres`;
   both routes do.)
2. **`.env.local`** — copy `.env.example`, fill `NEXT_PUBLIC_SUPABASE_URL` +
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Project Settings → API. Optionally
   `NEXT_PUBLIC_SITE_URL` (defaults to `http://localhost:3000`).
3. **Vercel env** — same two vars in Project Settings, plus `NEXT_PUBLIC_SITE_URL`
   set to the deployment URL.
4. **Supabase Auth settings** — Authentication → URL Configuration: Site URL =
   your prod URL; Redirect URLs must allow `http://localhost:3000/**` and
   `https://<prod>/**` (covers `/auth/callback` and `/auth/confirm`).
5. **Google provider** — create an OAuth client in Google Cloud, add the
   `https://<project-ref>.supabase.co/auth/v1/callback` redirect URI, paste
   client id/secret into Supabase → Authentication → Providers → Google.
6. Then verify end-to-end: sign up → confirm email → land on `/app`; sign out;
   sign in; Google sign-in; confirm a second account can't read the first's
   `profiles`/`organizations` row (RLS check).

### Spec §10 items now handled in code (for the planning pass to clear)

- "CI `build` will fail once a Supabase client initialises at module load" —
  env is read lazily + CI `build` has placeholder env + proxy degrades. Done.

- **Next:** M2 — organization create/edit form, type selection, contact fields,
  **search-triggered** Nominatim geocoding (per Design Decisions), zod validation.

## 2026-08-28 — Plan review + sprint re-order (planning; docs updated in vault)

- **Did:** Reviewed M0 with Alex — scaffold accepted. Confirmed Vercel + Supabase projects
  exist, so **M1 is unblocked**.
- **Spec changes (re-copied into this repo):**
  - New **§7.1 "Build order (sprint)"** — M1 → M2 → M3 (+ seed script) → deploy checkpoint →
    M6 → M4 → M7 → M8; M5 folds into every milestone. Build the working product + the
    strongest résumé feature (M6) first; M8 is first to cut.
  - Geocoder is **search-triggered, not keystroke autocomplete** (Nominatim policy) — §2, §4,
    §10 + a Design Decisions entry. Debounced "search address" action, cache results, real
    `User-Agent`; Photon is the fallback.
  - **M7 k6 measurement protocol** written into §9: local only (never load test Vercel),
    cache off vs on, one instrumented `lib/db` counter cross-checked with `pg_stat_statements`,
    commit the k6 script + JSON summaries + `docs/benchmarks/README.md`.
  - §10 TODO: **CI `build` will fail at M1** once a Supabase client initialises at module
    load — add placeholder `NEXT_PUBLIC_SUPABASE_*` env to the CI job or guard client
    creation. Also: branch protection on `main`, one PR + tag `v0.x-mN` per milestone,
    Lighthouse/axe in CI at M4.
- **New docs (in this repo):** `docs/Architecture.md` (living codebase map, current +
  planned) and `docs/Concepts.md` (append-only concept glossary — RSC, App Router, RLS,
  PostGIS, Realtime, …). **Working agreement (CLAUDE.md) now asks the coding agent to:**
  keep both current each milestone; add a plain-English "How this code works" walkthrough to
  every Sessions entry; work on a branch → PR → squash-merge → tag; keep `main` green +
  deployed; tests per-milestone, not a final phase.
- **Next:** M1 — auth (email/password + Google OAuth), `profiles` + `organizations` schema,
  RLS policies, protected `/app` route group, profile creation on first login. Start with
  the CI env fix so the pipeline stays green.

## 2026-08-27 — M0 scaffold

- **Did:** Scaffolded the Next.js app in `~/code/food-for-everyone`.
  - `create-next-app` → **Next.js 16.3.3**, React 19.2, **TypeScript strict**, Tailwind
    **v4**, ESLint 9 flat config, App Router, no `src/` dir, `@/*` import alias, Turbopack.
  - **shadcn/ui** init (`radix-nova` preset, Radix primitives, lucide icons). Added `Button`;
    `lib/utils.ts` (`cn`). shadcn ships a `shadcn/tailwind.css` import in `app/globals.css`.
  - **Visual direction wired in early** (Spec §8): `app/globals.css` now carries the warm
    off-white / near-black / deep-pine palette + green ramp tokens (`--brand`,
    `--brand-hover`, `--brand-support`, `--brand-amber`) mapped onto shadcn's semantic
    tokens, light + dark. Fonts swapped to **Newsreader** (headings) + **Public Sans**
    (body) via `next/font/google`. Placeholder home page uses them; real landing is M4.
  - **Tooling:** Prettier (+ `prettier-plugin-tailwindcss`, `eslint-config-prettier`),
    **Vitest** + React Testing Library + jsdom (`vitest.config.mts`, `vitest.setup.ts`),
    5 smoke tests passing (`cn`, `Button`). `.nvmrc` (22), `.env.example` (Supabase vars,
    unused until M1), merged `.gitignore`.
  - **CI:** `.github/workflows/ci.yml` — format check → lint → typecheck → test → build,
    on push to `main` + PRs. Node from `.nvmrc`, npm cache, telemetry off.
- **Problem / fix:**
  - `tsc --noEmit` failed on `LayoutProps<"/">` (Next 16 generated global type). Fix:
    `typecheck` script runs `next typegen && tsc --noEmit`.
  - `next dev` (Next 16 `agentRules`) appended a `<!-- nextjs-agent-rules -->` block to
    `CLAUDE.md` on every run. `CLAUDE.md` is the vault master — set `agentRules: false` in
    `next.config.ts`. Next 16's own docs are bundled at `node_modules/next/dist/docs/`.
  - Vitest warned about CJS-loaded ESM config and the now-native `vite-tsconfig-paths`.
    Fix: renamed config to `.mts`, dropped the plugin for `resolve.tsconfigPaths: true`.
- **Notes:** `create-next-app` also emitted an `AGENTS.md` stub — not copied into the repo;
  `CLAUDE.md` stays the single master brief. Prettier is scoped to exclude `docs/` and
  `CLAUDE.md` (Obsidian-authored). Local `format/lint/typecheck/test/build` all green.
- **Next:** Create the GitHub repo + Vercel project + Supabase project (Spec §10 TODO —
  needs Alex / the git agent), then **M1** (auth + profile, schema migration, RLS).

## 2026-08-27 — Auth-gating + name confirmed

- **Did:** Confirmed **auth-gated map for v1**. Deciding factor: "recipients" includes shelters,
  some of which keep addresses confidential for safety — a public exact-location map could do
  real harm. Also avoids contact scraping. Public-with-privacy-controls (approx location,
  gated contacts, per-org opt-out) recorded as a post-v1 option in [[Design Decisions]].
- **Did:** Added architecture rule — map/API responses expose org-level fields only, never the
  registering person's name or login email.
- **Did:** Name confirmed "Food For Everyone"; repo slug `food-for-everyone`
  (`github.com/achen135/food-for-everyone` returns 404 — available).
- **Next:** M0 scaffold.

## 2026-08-27 — Landing page mockup

- **Did:** Produced a redesigned landing-page mockup (desktop + mobile) as a design canvas:
  https://claude.ai/code/artifact/8f966820-3ca4-43e0-9301-55e84736fca8
  Working files in `design/` (`Main.dc.html`, `Mobile.dc.html`, `canvas.json`).
- **Direction shown:** green kept but demoted to accent over warm off-white + near-black text;
  deep pine actions, sage/amber accents; **Newsreader** headings (swapped in for the more
  over-used Fraunces) + **Public Sans** body; drawn abstract map as hero art.
- **Placeholders:** footer byline and contact link are stubs.
- **Feedback (Alex):** direction approved. Removed the traction/impact stat band — no real
  data yet; revisit post-launch. Mockup + Spec §8/§10 + Design Decisions updated to match.
- **Note:** Spec §8 type pairing still says "Fraunces + Inter" — update to
  "Newsreader + Public Sans" now that this direction is accepted.
- **Next:** M0 scaffold.

## 2026-08-27 — Visual direction + résumé-driven roadmap

- **Did:** Recorded the visual direction in [[Spec]] §8 (keep green, demote it to an accent,
  proper green ramp, Fraunces + Inter, lucide icons, photography-forward, AA contrast; starting
  colour tokens included). *(Correction: I claimed this was saved in the prior session's chat
  but had not actually written it — done now.)*
- **Did:** Read `Resume.md`. Mapped the three planned Food For Everyone bullets to
  post-refactor milestones: **M6** real-time donation requests (listings + claims, Supabase
  Realtime), **M7** caching + token-bucket rate limiter + k6 load-test report, **M8** real-time
  analytics dashboard (Recharts + Realtime, seeded demo data). Added Spec §9; updated §2
  Non-Goals. All three stay on free, no-card tiers.
- **Did:** Auth decision — email/password **and** Google OAuth, both from v1.
- **Notes:** Résumé needs a later consistency pass — tech line still says "React, Firebase";
  "multithreaded caching layer" doesn't fit the Node runtime; quantified figures should match
  seeded/real data once M6–M8 land. Captured in Spec §9 + §10 TODO.
- **Next:** landing-page visual mockup, then M0 scaffold.

## 2026-08-27 — Backend + maps decisions

- **Did:** Locked the backend as **Supabase** (Postgres + PostGIS + Auth + RLS; free tier, no
  card). Switched maps from Mapbox to **MapLibre GL + OpenFreeMap tiles** and geocoding to
  **Nominatim**, driven by a hard "no ongoing cost, no credit card" constraint. Updated
  [[Spec]] (§1 constraints, §4 stack, §5 secrets, §8) and [[Design Decisions]].
- **Notes:** Supabase free projects pause after ~7 days idle — un-pause before demoing.
  Protomaps self-hosting noted as the zero-cost upgrade path if OpenFreeMap/Nominatim limits bite.
- **Next:** minor open items (Google OAuth in v1?, visual direction), then M0 scaffold.

## 2026-08-27 — Legacy audit + project direction

- **Did:** Audited the old repo (`github.com/achen135/CirFin-Create`). Chose the rebuild
  direction and wrote the first full draft of `Spec.md` and `Design Decisions.md`.
- **Legacy findings:**
  - React 18 + Vite 5 SPA, React Router 6, plain CSS per component. Deployed to GitHub Pages
    with every route hard-prefixed `/CirFin-Create/`.
  - No backend — Firebase Auth (email/password) + Firestore called straight from the client.
    Google Maps JS API injected at runtime.
  - Single `businesses` Firestore collection; `role` is `donator` / `receiver`, nullable;
    `location` is a GeoPoint the user types in as **raw lat/long**.
  - `package.json` is currently **invalid JSON** — a CSS animation blob was pasted into it.
  - **Live API keys committed** (Firebase config + Google Maps key) and in git history.
  - No Firestore security rules in the repo. `Auth.jsx` manipulates the DOM directly
    (`getElementById(...).style`); `alert()` used for all feedback; dead route
    `/kite-hacks-proj/auth` in `Account.jsx`.
  - Deploy workflow uses deprecated actions (`checkout@v2`, Node 16). No tests, no TS.
- **Decisions locked:** new repo; Next.js App Router; TypeScript; Mapbox GL; Tailwind +
  shadcn/ui; auth-gated map. See [[Design Decisions]].
- **Still open:** backend (Supabase vs Prisma+Neon); Google OAuth in v1?; visual direction.
  See [[Spec]] §8.
- **Next:** resolve the backend question, then M0 scaffold.

## 2026-08-27 — Vault setup

- **Did:** Organized the planning vault. Created `docs/` for Spec, Design Decisions, and this
  log. `CLAUDE.md` sits at the folder root as the master context brief for the coding agent.
