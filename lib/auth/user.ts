import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * The authenticated user for the current request, memoised per request (M9).
 *
 * ## The problem this solves
 *
 * M7's benchmark found ~28 ms of a ~60 ms authenticated response going to
 * GoTrue round-trips, because `getUser()` was called independently by whatever
 * needed it. Rendering `/app/organization` and saving the form cost four:
 * the app layout, `getMyOrganization`, the Server Action's own check, and
 * `getMyProfile` — each ~14 ms, all asking the same question about the same
 * request.
 *
 * ## Why this is safe, from React's source rather than from the docs
 *
 * `cache()` reads `ReactSharedInternals.A` — the dispatcher Next installs per
 * request — and calls `dispatcher.getCacheForType(...)` to get its store. Two
 * consequences, both load-bearing:
 *
 *   - **There is no module-level cache.** The store hangs off the request's
 *     dispatcher, so one request's user cannot be handed to another. That is
 *     the failure the M9 brief called the most dangerous one available here,
 *     and it is structurally unreachable rather than merely unlikely.
 *   - **With no dispatcher, `cache()` calls straight through** (`if (!dispatcher)
 *     return fn.apply(null, arguments)`). Outside a request scope this degrades
 *     to the pre-M9 behaviour — an extra round-trip, never a stale identity.
 *
 * **Token revalidation is preserved.** This still calls `getUser()`, which
 * checks the token with the auth server; it does *not* switch to `getSession()`,
 * which would trust the cookie. What is cached is the result of one real
 * validation for the life of one request. See lib/supabase/middleware.ts:73.
 *
 * ## What this does *not* do
 *
 * The proxy (`proxy.ts` → `updateSession`) runs as a separate invocation from
 * the render, so its `getUser()` is outside this cache and still happens. That
 * call also refreshes the session cookie, so it is not removable anyway.
 * Collapsing it would mean passing a validated identity from the proxy to the
 * origin — a trusted header — which is an auth-bypass primitive and is
 * deliberately not done. See docs/Design Decisions.md.
 */
export const getAuthenticatedUser = cache(async (): Promise<User | null> =>
  loadAuthenticatedUser(),
);

/**
 * The un-memoised read. Exported for tests: under Vitest, `react` resolves to
 * the *client* build, whose `cache()` is an unconditional pass-through, so the
 * memoisation above is not observable there at all — only the behaviour here
 * is. The dedup is verified by running the app, not by a unit test; the counter
 * below is what makes that possible.
 */
export async function loadAuthenticatedUser(): Promise<User | null> {
  authCallCount += 1;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

/**
 * Counts actual GoTrue round-trips, the same instrumentation seam M7 built for
 * database reads (`lib/db/instrument.ts`). With the memoisation working this
 * should read 1 per authenticated request on the app routes; before M9 the
 * same page cost 2–4. Process-local and best-effort — right for a single-process
 * benchmark run, meaningless on serverless.
 */
let authCallCount = 0;

export function getAuthCallCount(): number {
  return authCallCount;
}

export function resetAuthCallCount(): void {
  authCallCount = 0;
}
