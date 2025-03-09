# Food For Everyone — Design Decisions

> The "why" behind every non-obvious choice: APIs, libraries, architecture, data model.
> Each entry should be something Alex can be asked about in an interview and answer well.

**Entry format**

### <Decision title>
- **Date:** YYYY-MM-DD
- **Context:** what problem forced the choice
- **Options considered:** A, B, C
- **Decision:** what we picked
- **Why:** the reasoning, including tradeoffs accepted
- **Revisit if:** conditions that would make us change our mind

---

### Rebuild in a new repo instead of refactoring in place
- **Date:** 2026-08-27
- **Context:** The original repo (`CirFin-Create`) is a hackathon build: one commit of history,
  an invalid `package.json`, live API keys committed to source, no tests, no security rules,
  React anti-patterns throughout, and routing hard-coupled to a GitHub Pages sub-path.
- **Options considered:** (a) incremental refactor on the existing repo; (b) fresh repo, port
  the concept only.
- **Decision:** Fresh repo, `food-for-everyone`.
- **Why:** The framework, language, styling approach, data layer, and hosting are all changing
  at once, so almost no code survives. A clean history also means the leaked keys never appear
  in `git log`, and the repo reads as deliberate work rather than a patched hackathon project.
- **Revisit if:** n/a — committed.

### Next.js (App Router) over React + Vite SPA
- **Date:** 2026-08-27
- **Context:** Need a React framework for a resume project targeting SWE internships.
- **Options considered:** React + Vite SPA (the current setup); Next.js App Router; Remix.
- **Decision:** Next.js App Router on Vercel.
- **Why:** Server components + Route Handlers let the browser stay out of the database
  entirely — auth and authorization run on the server, which is the correct security posture
  and a good interview talking point. Next.js is also the most in-demand React skill, so it is
  the higher-signal choice for internship applications. Vercel gives zero-config deploys and
  per-PR preview URLs. Tradeoff: more concepts to learn (RSC vs client components, caching,
  middleware) than a plain SPA.
- **Revisit if:** we find we need no server-side logic at all (we do — geo queries, auth).

### TypeScript over JavaScript
- **Date:** 2026-08-27
- **Context:** The old project is plain JS with no prop validation.
- **Options considered:** stay JS; adopt TypeScript.
- **Decision:** TypeScript, strict mode.
- **Why:** Near-universal expectation for internships; catches an entire class of bugs at
  author time; lets zod schemas and DB types flow through the app as real types. Conversion
  cost is low because we are starting fresh. Tradeoff: slightly slower to write, need to learn
  generics / utility types.
- **Revisit if:** n/a — committed.

### MapLibre GL over Mapbox GL, Google Maps, and Leaflet
- **Date:** 2026-08-27 (revised same day after the zero-cost constraint was set)
- **Context:** Core feature is a map of organizations. The old build injected the Google Maps
  script at runtime with an unrestricted key in source. Hard constraint: no cost, no credit
  card on file.
- **Options considered:**
  - Google Maps JS API — requires a billing account.
  - Leaflet + OpenStreetMap raster tiles — free, key-less, but raster tiles look dated.
  - Mapbox GL JS — modern vector, but its free tier's card requirement is now ambiguous and
    usage over 50k loads/month auto-bills.
  - **MapLibre GL** (open-source fork of Mapbox GL v1) + OpenFreeMap vector tiles — no account,
    no key, no card, nothing that can bill.
- **Decision:** MapLibre GL via `react-map-gl/maplibre`, tiles from OpenFreeMap. Geocoding via
  Nominatim (OpenStreetMap).
- **Why:** Same modern vector rendering and the same `react-map-gl` React binding we'd have
  used with Mapbox (the library supports both), but with zero billing surface. Built-in
  clustering via GeoJSON sources. Satisfies the no-card constraint absolutely.
- **Tradeoff accepted:** OpenFreeMap and Nominatim are community-run with fair-use limits —
  fine for portfolio traffic, and both require visible attribution. If limits ever bite,
  self-hosting Protomaps PMTiles (one static file on Vercel/Supabase storage) is a zero-cost
  upgrade and a stronger interview story.
- **Revisit if:** the no-card constraint is lifted → Mapbox offers nicer default styling and a
  managed geocoder.

### Auth-gated map (v1)
- **Date:** 2026-08-27 (confirmed)
- **Context:** The map exposes organization name, address/exact location, email, and phone.
- **Options considered:** public map; public map with privacy controls (approximate location,
  gated contacts, per-org opt-out); map visible only to authenticated organizations.
- **Decision:** Auth-gated for v1.
- **Why:**
  - **Sensitive addresses.** "Recipients" includes shelters; some (e.g. domestic-violence
    shelters) deliberately keep their address confidential for resident safety. A public
    exact-location map could cause real harm. Auth-gating sidesteps this entirely for v1.
  - **Scraping.** A public directory of org emails/phones invites spam and phishing.
  - **Framing.** "Everyone on the map is a real, registered participant" is the product's
    trust model.
  - Tradeoff: friction for a curious visitor — mitigated by a landing page that sells the
    value before asking for a signup.
- **Post-v1 option:** a public directory *with* privacy controls — snap/jitter location to
  neighborhood for anonymous viewers, reveal exact address + contacts only to signed-in
  counterparties, and a per-org "hide from public / hide exact address" toggle defaulting to
  hidden for shelters. Worth doing only if reach becomes a goal.
- **Revisit if:** we want public reach and have built the privacy controls above.

### Tailwind CSS + shadcn/ui over hand-written CSS or a component library
- **Date:** 2026-08-27
- **Context:** The old project has one plain `.css` file per component, no design system,
  no dark mode, inconsistent spacing.
- **Options considered:** keep per-component CSS / CSS Modules; a batteries-included library
  (MUI, Chakra); Tailwind + shadcn/ui (Radix primitives, copied into the repo).
- **Decision:** Tailwind CSS + shadcn/ui.
- **Why:** Gives a consistent design-token system (spacing, colour, typography) and dark mode
  for free, while shadcn components are accessible (Radix) and live in our own source so we can
  read and modify them — good for both polish and code review. MUI/Chakra would impose their
  own look and a large runtime. Tradeoff: Tailwind's class-heavy markup takes adjustment.
- **Revisit if:** n/a — low cost to change early if it grates.

---

### Backend / data layer — Supabase
- **Date:** 2026-08-27
- **Context:** Need auth + a database with geospatial queries ("recipients within 15 km").
  The old build used Firebase Auth + Firestore directly from the client, with no security
  rules. Hard constraint: no ongoing cost, no credit card on file.
- **Options considered:**
  - **Supabase** — hosted Postgres + PostGIS + Auth + Row Level Security + storage; free tier, no card.
  - **Prisma + Neon Postgres + Auth.js** — assemble the pieces ourselves; also free-tier-able.
  - Firebase / Firestore — document DB, weak fit for relational + geo; the reason we're rebuilding.
- **Decision:** Supabase.
- **Why:** One service covers auth, a real relational Postgres schema (good SQL / schema-design
  interview material), PostGIS for native distance queries, and RLS for defense-in-depth — all
  free with no card. Prisma + Neon is marginally more "hand-wired" portfolio cred but more
  surface area to build and secure, with no time budget to spare.
- **Tradeoff accepted:** Supabase free projects pause after ~7 days of inactivity (manual
  un-pause, or a keep-alive ping). 500 MB DB / 50k monthly active users is ample here.
- **Revisit if:** we outgrow the free tier, or the auto-pause disrupts demos enough to justify
  moving to Neon (per-request auto-resume).

### Auth methods: email/password + Google OAuth, both from v1
- **Date:** 2026-08-27
- **Context:** The old app was email/password only. Deciding what to support in the rebuild.
- **Options considered:** email/password only; Google OAuth only; both.
- **Decision:** Both, from v1.
- **Why:** Supabase Auth provides both on the free tier; Google is one provider config with no
  extra cost. Google sign-in removes friction for most users; email/password keeps the app
  usable without a Google account. Low marginal cost to have both.
- **Revisit if:** n/a.

### Visual identity: keep green, elevate execution
- **Date:** 2026-08-27
- **Context:** The current site "looks like a high-schooler built it." Alex likes the green and
  wants an upgrade of the existing direction, not a reinvention.
- **Options considered:** new palette/brand; keep green but fix how it's applied.
- **Decision:** Keep green; fix execution. Neutral-dominant layout, green demoted to an accent,
  a proper green ramp (deep pine for actions, sage for tints only), real type hierarchy
  (Newsreader headings + Public Sans body — chosen over the more over-used Fraunces/Inter),
  one icon set, photography-forward sections, AA contrast. Details in [[Spec]] §8.
- **Why:** The palette was never the problem — the problems were a full green wash, no type
  hierarchy, mismatched PNG icons, and placeholder decoration. Fixing application is faster
  than rebranding and keeps the identity Alex already likes.
- **Revisit if:** the mockup shows the green still fights the content — then adjust the ramp,
  not the whole direction.

### No traction/impact stats on the landing page (for now)
- **Date:** 2026-08-27
- **Context:** The mockup had an "impact band" (partner orgs, neighborhoods, lbs redirected)
  with bracketed placeholder numbers. There is no real usage data.
- **Options considered:** keep it with bracketed placeholders; keep it with illustrative
  round numbers + a disclaimer; remove it until there is real data.
- **Decision:** Remove it. Landing goes hero → how-it-works → both-sides value → CTA → footer.
- **Why:** Placeholder or illustrative stats on a live-looking page read as either unfinished
  or misleading, and this is a page an interviewer might see. Nothing is lost by omitting it —
  the section can return post-launch, or once M8's seeded analytics exist and can be labelled
  as seeded.
- **Revisit if:** real participation data exists, or M8 ships and we want a clearly-labelled
  "sample data" band.

### Refactor before features; the roadmap is résumé-driven
- **Date:** 2026-08-27
- **Context:** `Resume.md` lists Food For Everyone with bullets the current app doesn't support
  (real-time donation requests; a caching + token-bucket rate-limit layer with load-test
  numbers; a real-time analytics dashboard). Need to decide build order.
- **Options considered:** (a) bolt the new features onto the existing hackathon code, then
  refactor; (b) refactor to the new stack first (M0–M5), then build features (M6–M8).
- **Decision:** Refactor first, then features.
- **Why:** Every new feature depends on what the refactor establishes — a relational schema,
  server-side API routes to put a rate limiter in front of, instrumented DB access, Supabase
  Realtime. Building them on the old client-only Firebase code would mean throwing that work
  away. Refactor-first also means the résumé bullets end up backed by the clean codebase an
  interviewer actually reads.
- **Integrity note:** each feature milestone commits evidence (k6 output, seed script,
  screenshots) so every quantified résumé claim is traceable to something in the repo. Seeded
  demo data is described as seeded in interviews, never as organic production traffic.
- **Revisit if:** an application deadline forces a feature demo before the refactor is done —
  then cherry-pick M8 (most visual) on top of whatever is ready.
