import { NextResponse } from "next/server";

import { getAuthCallCount, resetAuthCallCount } from "@/lib/auth/user";
import { appCache } from "@/lib/cache";
import { getReadCount, resetReadCount } from "@/lib/db";

/**
 * Counters for the M7 benchmark (Spec §9).
 *
 * `GET`    → database reads and cache statistics since the last reset.
 * `DELETE` → zero them, so a run measures only itself.
 *
 * Off unless `BENCHMARK_MODE=1`, and it answers **404** rather than 403 when
 * off: a disabled endpoint should be indistinguishable from one that was never
 * deployed. It exposes counters only — no rows, no identifiers — but it is
 * still instrumentation, and instrumentation that is reachable in production is
 * a way in that nobody asked for.
 *
 * The numbers are per-process, which is exactly right for the benchmark (one
 * `next start`, one process) and meaningless on serverless, where each instance
 * would report its own slice.
 */
export const dynamic = "force-dynamic";

function enabled(): boolean {
  return process.env.BENCHMARK_MODE === "1";
}

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET() {
  if (!enabled()) return NOT_FOUND;

  return NextResponse.json(
    {
      dbReads: getReadCount(),
      // M9: GoTrue round-trips. `getAuthenticatedUser` memoises per request, so
      // this should track requests, not call sites — see lib/auth/user.ts.
      authCalls: getAuthCallCount(),
      cache: appCache.stats(),
      config: {
        cacheEnabled: process.env.CACHE_DISABLED !== "1",
        rateLimitEnabled: process.env.RATE_LIMIT_DISABLED !== "1",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE() {
  if (!enabled()) return NOT_FOUND;

  resetReadCount();
  resetAuthCallCount();
  appCache.resetStats();
  // Entries too, not just the statistics — a run that starts with a warm cache
  // from the previous run measures the wrong thing.
  appCache.clear();

  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
