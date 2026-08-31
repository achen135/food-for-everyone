import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Always run at request time. A prerendered health check would return a cached
 * body and never touch Postgres — which is the entire point of this endpoint.
 */
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Two jobs:
 *  1. **Liveness** — is the app up, and can it reach Postgres?
 *  2. **Keep-alive** — Supabase free projects pause after ~7 days idle. The
 *     cron in `.github/workflows/keepalive.yml` hits this every few days so the
 *     demo link stays live through the application window.
 *
 * Public on purpose: the cron has no session. It discloses nothing useful —
 * the query runs as `anon`, so RLS already restricts it, and it asks for at
 * most one id which is never included in the response. Only status is returned.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    // Cheapest round-trip that still proves Postgres answered. Under RLS as
    // `anon` this returns an empty set, which is a success, not an error.
    const { error } = await supabase
      .from("organizations")
      .select("id")
      .limit(1);
    if (error) throw error;

    return NextResponse.json(
      {
        status: "ok",
        database: "reachable",
        latencyMs: Date.now() - startedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Deliberately no error detail — this endpoint is public.
    return NextResponse.json(
      { status: "degraded", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
