# Food For Everyone — Concepts

> An append-only glossary of the framework / database / tooling concepts this codebase uses.
> One entry per concept: what it is, why it's here, and where to see it in the repo. Written
> so Alex can learn the stack *from* the project. New entries go at the bottom of the relevant
> section as the code introduces them; don't rewrite old entries, add "Update:" lines if
> something changes.
>
> Companion: [`Architecture.md`](Architecture.md) (how the pieces connect),
> [`Design Decisions.md`](Design%20Decisions.md) (why each was chosen).

**Entry format**

### <concept>
- **Is:** one or two plain sentences.
- **Why here:** what it does for this project.
- **In the repo:** file(s) to look at. "not yet" if planned.
- **Learn more:** a doc link or search term.

---

## Next.js / React

### React Server Components (RSC) vs Client Components
- **Is:** In the App Router, components render on the server by default and ship as HTML with
  little or no JavaScript. A file opts into browser interactivity with `"use client"` at the
  top; only then can it use `useState`, event handlers, browser APIs.
- **Why here:** The landing page and most data-fetching pages have no reason to run JS on the
  client — faster first paint, and secrets/DB access stay server-side. Only the map is truly
  interactive.
- **In the repo:** `app/page.tsx`, `app/layout.tsx` are server components (no `"use client"`).
  First client component will be the map at M3.
- **Learn more:** Next.js docs, "Server and Client Components".

### App Router & route segments
- **Is:** Each folder under `app/` is a URL segment; `page.tsx` makes it routable, `layout.tsx`
  wraps everything below it. Parenthesised folders like `(marketing)` group routes without
  adding to the URL.
- **Why here:** Lets the public site and the authenticated app have separate layouts and a
  single middleware gate on `/app/*`.
- **In the repo:** `app/page.tsx`, `app/layout.tsx`. Route groups arrive at M1/M4.
- **Learn more:** Next.js docs, "Routing: Route Groups".

### `next/font`
- **Is:** Build-time font loading — Next downloads the font, self-hosts it, and exposes a CSS
  variable, so there's no layout shift and no request to Google at runtime.
- **Why here:** Newsreader (headings) + Public Sans (body) per Spec §8, wired at M0.
- **In the repo:** `app/layout.tsx` (`Newsreader`, `Public_Sans` → `--font-heading`,
  `--font-sans`), consumed in `app/globals.css`.

### Generated route types (`LayoutProps`, `PageProps`)
- **Is:** Next 16 generates a typed contract for each route's props (params, searchParams).
  `tsc` needs those generated first, hence `next typegen && tsc --noEmit`.
- **Why here:** Caught at M0 — `typecheck` script runs typegen first.
- **In the repo:** `package.json` `typecheck` script; `app/layout.tsx` uses `LayoutProps<"/">`.

### `proxy.ts` (was `middleware.ts`)
- **Is:** A file at the repo root exporting a function Next runs *before* every
  matched request, on the Edge-style runtime. It can rewrite, redirect, or set
  cookies. Next 16 renamed the convention from `middleware` to `proxy`
  (`middleware.ts` still works but warns).
- **Why here:** One place to (a) refresh the Supabase auth cookie so Server
  Components see a live session and (b) redirect logged-out `/app/*` requests to
  `/sign-in`. `config.matcher` skips static assets.
- **In the repo:** `proxy.ts` → `lib/supabase/middleware.ts` (`updateSession`).
- **Learn more:** Next.js docs, "proxy" / "middleware"; Supabase "Server-Side Auth (Next.js)".

### Server Actions
- **Is:** An `async` function marked `"use server"` that runs only on the server
  but can be called straight from a Client Component (React serializes the call).
  Redirects and `revalidatePath` work inside it. No hand-written API route.
- **Why here:** The auth mutations (`signIn`, `signUp`, `signOut`). The client
  form calls the action; the action re-validates with the same zod schema and
  talks to Supabase.
- **In the repo:** `app/(auth)/actions.ts`, called from `components/auth/*-form.tsx`.
- **Learn more:** Next.js docs, "Server Actions and Mutations".

### `useTransition` for pending UI
- **Is:** `const [isPending, startTransition] = useTransition()` — wrap an async
  action call in `startTransition` and `isPending` is true until it settles,
  without manual `useState` bookkeeping.
- **Why here:** Disables the submit button / shows "Signing in…" while a Server
  Action runs.
- **In the repo:** `components/auth/sign-in-form.tsx`, `sign-up-form.tsx`.

## Styling

### Tailwind v4 `@theme` and design tokens
- **Is:** Tailwind v4 is configured in CSS, not `tailwind.config.js`. `@theme` maps CSS
  variables to utility classes (e.g. `--color-brand` → `bg-brand`). Our brand variables are
  defined on `:root` and `.dark` and referenced from `@theme inline`.
- **Why here:** One source of truth for the Spec §8 palette, light + dark, usable as normal
  Tailwind classes.
- **In the repo:** `app/globals.css`.

### shadcn/ui (vendored components)
- **Is:** Not an installed component library — a CLI copies component source (built on Radix
  primitives) into `components/ui/` so the code is ours to read and edit.
- **Why here:** Accessible primitives without a black-box dependency; good for code review.
- **In the repo:** `components/ui/button.tsx`, `components.json`.

## Tooling

### ESLint flat config
- **Is:** ESLint 9's `eslint.config.mjs` format (an array of config objects) replacing
  `.eslintrc`.
- **In the repo:** `eslint.config.mjs`.

### Vitest config as `.mts`
- **Is:** `.mts` forces the config to load as an ES module, avoiding a CJS/ESM warning; path
  aliases come from `resolve.tsconfigPaths: true` instead of a plugin.
- **In the repo:** `vitest.config.mts`, `vitest.setup.ts`.

### Mocking modules in Vitest (`vi.mock`)
- **Is:** `vi.mock("path", factory)` replaces a module for the test file. Hoisted
  above imports, so the real module (and its side effects) never loads.
- **Why here:** `SignInForm` imports the `"use server"` actions module, which
  pulls `next/headers` — unloadable in jsdom. The RTL test mocks
  `@/app/(auth)/actions` and `sonner`.
- **In the repo:** `components/auth/sign-in-form.test.tsx`.

## Supabase / Auth / Postgres

### Supabase SSR session (`@supabase/ssr`)
- **Is:** The auth session (a JWT + refresh token) lives in cookies. `@supabase/ssr`
  gives you a **browser** client (`createBrowserClient`) and a **server** client
  (`createServerClient`) that you hand cookie get/set functions. The server
  client is built fresh per request — never module scope.
- **Why here:** The browser never holds a DB credential; the server reads the
  cookie and every query runs as that user (so RLS applies).
- **In the repo:** `lib/supabase/client.ts`, `lib/supabase/server.ts`,
  `lib/supabase/middleware.ts`.
- **Learn more:** Supabase docs, "Server-Side Auth › Next.js".

### `auth.getUser()` vs `auth.getSession()`
- **Is:** `getSession()` just decodes the cookie (fast, spoofable if you trust it
  blindly). `getUser()` calls the Supabase Auth server to verify the token.
- **Why here:** Anywhere an auth decision is made (`proxy.ts`, `app/app/layout.tsx`)
  uses `getUser()`. Don't put logic between creating the server client and the
  `getUser()` call — it can desync the refreshed cookie.

### Row Level Security (RLS)
- **Is:** Per-row access rules enforced by Postgres. A table with RLS enabled
  denies everything until a `policy` allows it. Policies are boolean SQL over the
  row plus `auth.uid()` (the current user's id, from the JWT).
- **Why here:** Defense in depth. Even if a Route Handler forgot to check
  ownership, `using (auth.uid() = owner_id)` means the query returns nothing.
- **In the repo:** `supabase/migrations/20260828223018_init.sql` — `profiles`
  and `organizations` are own-row only for M1. Uses `(select auth.uid())` (the
  Supabase perf idiom — the planner caches it as an initplan).

### Postgres migrations (Supabase CLI)
- **Is:** Schema changes as ordered, timestamp-named SQL files. `supabase db push`
  applies the un-applied ones to the linked project; the SQL editor works too.
- **Why here:** The schema is reviewable in git and reproducible, not clicked
  together in a dashboard.
- **In the repo:** `supabase/migrations/`, `supabase/config.toml`.

### `security definer` trigger on `auth.users`
- **Is:** A function that runs with *its owner's* privileges (here `postgres`),
  not the caller's — so it can write past RLS. `set search_path = ''` forces
  every name to be schema-qualified (a hardening measure).
- **Why here:** `handle_new_user()` fires `after insert on auth.users` and
  creates the `public.profiles` row, copying `full_name` from the signup
  metadata. `getOrCreateProfile()` is the app-side backstop.
- **In the repo:** `supabase/migrations/20260828223018_init.sql`.

### OAuth + PKCE code exchange
- **Is:** The provider (Google) redirects back with a short-lived `?code=`. The
  server swaps it for a session with `exchangeCodeForSession(code)` (PKCE proves
  the same client that started the flow is finishing it). Email confirmation is
  the same idea with `verifyOtp({ token_hash, type })`.
- **In the repo:** `app/auth/callback/route.ts`, `app/auth/confirm/route.ts`.

### zod schema shared client + server
- **Is:** One schema object imported by both the client form (via
  `@hookform/resolvers/zod`) and the Server Action, which re-`safeParse`s it.
- **Why here:** The client gets instant field errors; the server never trusts
  the client. Zod v4: use `z.flattenError(err)` for `{ fieldErrors }`.
- **In the repo:** `lib/validation/auth.ts`.

---

## Coming up (stubs to fill as milestones land)

- **PostGIS `geography` vs `geometry`, GiST index, `ST_DWithin`** — how "orgs within N km" works. [M3]
- **GeoJSON source + clustering in react-map-gl** — how many pins render efficiently. [M3]
- **Search-triggered geocoding** — debounced Nominatim lookup + result cache (not per-keystroke). [M2]
- **Supabase Realtime channels** — Postgres change stream pushed to the browser. [M6]
- **Token-bucket rate limiting** — the algorithm, and why in-process before Redis. [M7]
- **Read-through cache + stale-while-revalidate** — cache shape and invalidation, hung off `lib/db` `tracked()`. [M7]

---

## Change log

- **2026-08-28** — M1: added `proxy.ts`, Server Actions, `useTransition`, `vi.mock`,
  and the "Supabase / Auth / Postgres" section (SSR session, `getUser` vs
  `getSession`, RLS, migrations, `security definer` trigger, PKCE, shared zod).
- **2026-08-28** — created with the M0 concepts; "coming up" list seeded from the milestones.
