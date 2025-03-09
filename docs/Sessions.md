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
