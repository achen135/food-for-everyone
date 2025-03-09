# Food For Everyone — Spec

> Human-facing design document. What we're building, and how we intend to build it.
> Written so Alex can understand and defend every part of it in an interview.

## 1. Overview

Food For Everyone connects **food donors** (restaurants, grocers, farms) with **food
recipients** (food banks, shelters, community fridges) through a shared map. An organization
registers, declares whether it gives or receives surplus food, sets its location, and appears
on a map to counterparties in its area so the two sides can coordinate donations directly.

It is a ground-up rebuild of an earlier hackathon project (repo `CirFin-Create`, Firebase
project `kite-hacks`), rearchitected for maintainability, security, and a professional
presentation. Nothing is carried over but the concept.

**Constraints**
- **Zero ongoing cost, no credit card on file.** Everything runs on free tiers: Vercel Hobby,
  Supabase free, OpenFreeMap tiles, Nominatim geocoding. No service that can auto-bill.
- Solo build, planned in this vault, coded and committed by a separate agent.

## 2. Goals / Non-Goals

**Goals (v1)**
- Organizations can register, verify their email, and sign in.
- An organization has a profile: name, type (donor / recipient), description, contact info, address.
- Address entry is autocomplete-backed; coordinates are derived by geocoding, never hand-typed.
- A map shows relevant counterparties (donors see recipients, recipients see donors), with
  marker clustering and detail popups.
- Filter/search the map by distance, name, and type.
- Responsive, accessible (keyboard + screen reader), light/dark, fast first paint.

**Non-Goals (v1)** — v1 is the refactor only. The first three below are roadmapped in §9.
- Individual food listings / inventory ("40 lbs of produce until 6pm") → M6.
- Real-time analytics dashboard → M8.
- Caching / rate-limiting / load-test layer → M7.
- In-app messaging or pickup scheduling — not planned.
- Admin dashboard / verification workflow — v1 uses a manual `verified` flag.
- Native mobile apps; payments, logistics, delivery routing — not planned.

## 3. Users & Use Cases

- **Donor org admin** — signs up, marks org as donor, sets address + description, opens the
  map, sees nearby recipients, contacts one via the phone/email in the popup.
- **Recipient org admin** — the mirror: sees nearby donors.
- **Visitor (unauthenticated)** — sees the landing page (mission, impact, contact) and is
  prompted to register. Does **not** see the map, so organization contact data can't be scraped.

## 4. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router), React, **TypeScript** | Vercel hosting; RSC + Route Handlers / Server Actions |
| Styling | Tailwind CSS + shadcn/ui (Radix primitives) | We own the component code; accessible by default |
| Maps | **MapLibre GL** via `react-map-gl/maplibre` + OpenFreeMap tiles | Open-source, vector, clustering; no account, no key, no card |
| Geocoding | **Nominatim** (OpenStreetMap) | Address autocomplete; attribution + fair-use policy, self-host later if needed |
| Database | Postgres via **Supabase** + PostGIS | Auth + Row Level Security included; free tier, no card |
| Auth | Supabase Auth (email/password; Google OAuth TBD) | Cookie session via `@supabase/ssr` |
| Forms | react-hook-form + zod | zod schemas shared client + server |
| Notifications | sonner toasts | replaces every `alert()` |
| Testing | Vitest + React Testing Library; Playwright for E2E happy paths | |
| CI | GitHub Actions: lint, typecheck, test, build; Vercel preview deploys | |

## 5. Architecture

- **Rendering** — landing page is static / RSC. The authenticated app (`/app/*`) mixes server
  components for data fetching with client components for the interactive map.
- **Data access** — the browser never talks to the database directly. Reads and writes go
  through Route Handlers / Server Actions that authenticate the Supabase session and enforce
  authorization. Row Level Security is a second layer of defense.
- **Session** — Supabase cookie-based session, read in middleware and server components via
  `@supabase/ssr`.
- **Map data flow** — client requests `/api/orgs?type=…&near=lat,lng&radiusKm=…`; the handler
  runs a PostGIS `ST_DWithin` query scoped to the caller's counterparty type and returns
  GeoJSON; `react-map-gl` renders it as a clustered source.
- **Secrets** — all keys in environment variables (Vercel + `.env.local`). No map key is
  needed (MapLibre + OpenFreeMap). The Supabase anon key is safe to ship to the client; the
  service-role key is server-only and never imported into a client component.

## 6. Data Model (first draft)

**`organizations`**
| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | text | |
| `type` | enum `donor` \| `recipient` | |
| `description` | text | |
| `email` / `phone` | text | contact shown in map popup |
| `website` | text null | |
| `address` | text | formatted string from geocoder |
| `location` | `geography(Point, 4326)` | PostGIS; GiST index |
| `verified` | boolean default false | manual for v1 |
| `owner_id` | uuid → `auth.users` | |
| `created_at` / `updated_at` | timestamptz | |

**`profiles`** (1:1 with auth user)
| column | type | notes |
|---|---|---|
| `id` | uuid pk → `auth.users` | |
| `full_name` | text | |
| `organization_id` | uuid → `organizations` null | |
| `created_at` | timestamptz | |

Renames from the old model: `businesses` → `organizations`; `donator` / `receiver` →
`donor` / `recipient`; hand-typed GeoPoint → geocoded `location` + `address`.

## 7. Implementation Plan / Milestones

**M0 — Scaffold.** New repo `food-for-everyone`. Next.js + TS + Tailwind + shadcn/ui.
ESLint/Prettier. CI skeleton. Deploy empty app to Vercel.

**M1 — Auth + profile.** Supabase project, schema migration, RLS policies. Sign up / in / out
/ email verify. Protected `/app` route group. Profile creation on first login.

**M2 — Organization profile.** Create/edit organization. Address autocomplete + geocode.
Type selection. Contact fields with zod validation.

**M3 — Map.** `react-map-gl` map, browser geolocation, PostGIS radius endpoint, clustered
markers, detail popups, distance/name/type filters, empty + loading states.

**M4 — Landing + polish.** Redesigned landing per the mockup — hero, how-it-works,
both-sides value, closing CTA, footer (no traction-stat band for now). Responsive pass,
a11y pass, dark mode, skeletons, SEO metadata, README with screenshots.

**M5 — Tests + hardening.** Vitest on schemas/utils, RTL on key components, Playwright happy
path (sign up → create org → see map). Rate-limit write endpoints. Final RLS review.

## 8. Visual Direction

A starting point, expected to evolve during M4. Keep the green — the old look failed on
*execution*, not palette: green was used as a full wash (green body text, green-tinted
surfaces), type shouted without hierarchy (all-caps hero), icons were mismatched PNGs, and
there was placeholder decoration (`<div>empty</div>` circles). Charity-sector sites worth
studying: charity: water, World Central Kitchen, Feeding America, GiveDirectly, Too Good To Go.

**Principles**
- **Neutral-dominant, green as accent.** Warm off-white background, near-black text. Green is
  for primary buttons, links, highlights, and small tint blocks — never body copy.
- **Deliberate green ramp**, not one flat sage. Deep pine for actions/links (must pass WCAG
  AA on white); the old lighter sage becomes a support/tint colour only; a pale green for
  section backgrounds. Optional warm amber accent, used sparingly for emphasis.
- **Real type hierarchy.** Newsreader (warm editorial serif) for headings + Public Sans for
  body — both free Google Fonts. Sentence case, large headings, tight leading. No all-caps.
- **One of everything:** one icon set (lucide, ships with shadcn/ui), one spacing scale, one
  corner radius, subtle shadows and borders.
- **Photography-forward** hero and mission sections, with a gradient overlay for text
  legibility. Unsplash placeholders, swappable later.
- **No traction/impact stats** until there is real data to show (decided 2026-08-27). A stat
  band returns post-launch, or once M8's seeded analytics exist and can be labelled as such.
- **Accessibility:** AA contrast minimum, visible focus rings, `prefers-reduced-motion`
  respected. Motion is short (150–250ms) and restrained — entrance fades, nothing bouncy.

**Starting tokens** (to be refined in the mockup / M4)

| Token | Light | Notes |
|---|---|---|
| `--bg` | `#FBFBF8` | warm off-white |
| `--surface` | `#FFFFFF` / `#F3F6F0` | card / tinted section |
| `--text` | `#1A2B22` | near-black, green undertone |
| `--text-muted` | `#4B5A52` | secondary copy |
| `--brand` | `#1F6E43` | deep pine — buttons, links (AA on `--bg`) |
| `--brand-hover` | `#17512F` | |
| `--brand-support` | `#8DB580` | evolved sage — tints, illustration only |
| `--accent` | `#E8A33D` | warm amber, sparing |
| `--border` | `#E4E7E2` | |

Dark mode: `--bg #121A16`, `--surface #1A241E`, `--text #E8ECE8`, `--brand #5FB37E`.

## 9. Post-v1 Roadmap (résumé-driven)

These come **after** the M0–M5 refactor. Each feature exists to make the product useful *and*
to substantiate a specific résumé bullet, so each milestone must commit **evidence**
(benchmark output, seed script, screenshots) — not just code. The zero-cost / no-card
constraint (§1) still holds for every item.

**M6 — Donation requests (real-time).**
Donors post surplus listings (item, quantity, pickup window, notes); recipients browse and
claim. Status lifecycle: `open → claimed → completed / cancelled / expired`. Supabase Realtime
(Postgres change stream, included on the free tier) pushes updates to both parties live;
in-app toasts, optional email via Resend free tier. New tables: `listings`, `claims`.
→ backs *"real-time donation requests between donors and recipients."*

**M7 — Performance layer.**
Token-bucket rate limiter on API route handlers, with unit tests (in-process by default;
Upstash Redis free tier only if we want it distributed across Vercel instances). Read-through
cache with TTL + stale-while-revalidate on hot endpoints (map query, org lists), with DB-read
counters before/after. Load test with **k6** (local, free): record p50/p95 latency and read
counts into `docs/Sessions.md` and `docs/benchmarks/`.
→ backs *"caching layer + token-bucket rate limiter — X% fewer DB reads, p50 A ms → B ms under
load."* Numbers come from the recorded k6 run, not estimates.

**M8 — Analytics dashboard (real-time).**
Authenticated dashboard: completed donations over time, active listings, orgs by type,
fulfilment rate, geographic spread. Recharts (shadcn chart components), live-updating via the
same Realtime subscription. A seed script generates realistic historical activity for the
demo; dashboard counts reflect that seeded data — describe it as seeded/simulated in
interviews, not organic production traffic.
→ backs *"real-time analytics dashboard tracking 200+ donations."*

**Résumé alignment (later pass, non-blocking):** tech line "React, Firebase" →
"Next.js, TypeScript, PostgreSQL/PostGIS, Supabase"; "multithreaded caching layer" doesn't fit
a Node/serverless runtime — reword to "in-memory read-through cache with TTL"; dates and the
"15+ restaurants / 3 food banks / 200+ transactions" figures should match whatever the
seeded/real data actually shows once M6–M8 land.

## 10. Open Questions / TODO

Keep this current between planning sessions. Settled question → move reasoning to
[[Design Decisions]] and delete here. Task started → track in [[Sessions]] and delete here.

### Open Questions
- [ ] Confirm OpenFreeMap + Nominatim fair-use limits are fine for demo traffic; if not,
  self-host Protomaps PMTiles (zero cost, stronger interview story).
- [ ] M7: verify Upstash free tier needs no card at signup (fallback: in-process limiter only).

### Resolved
- Auth-gated map for v1 (sensitive shelter addresses + scraping). Public-with-privacy-controls
  is a post-v1 option. → [[Design Decisions]]
- Name confirmed "Food For Everyone"; repo slug `food-for-everyone` (`achen135/food-for-everyone`
  is free as of 2026-08-27).

### TODO
- [ ] Rotate the exposed Google Maps API key in the old project; restrict or delete it.
- [ ] Create the new GitHub repo (`food-for-everyone`) and Vercel project.
- [ ] Create the Supabase project (free tier). Note: free projects pause after ~7 days idle —
  un-pause before sharing the link, or add a lightweight keep-alive ping.
- [ ] Résumé consistency pass once M6–M8 land (see §9).
