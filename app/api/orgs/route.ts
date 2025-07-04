import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { findCounterpartiesNear } from "@/lib/db";
import { toFeatureCollection } from "@/lib/geojson";
import {
  mapQueryLimiter,
  rateLimitHeaders,
  rateLimitingEnabled,
} from "@/lib/rate-limit";
import { getAuthenticatedUser } from "@/lib/auth/user";
import { parseOrgsQuery } from "@/lib/validation/map";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/orgs?near=lat,lng&radiusKm=25&q=text
 *
 * Counterparties near a point, as a GeoJSON FeatureCollection for the map's
 * clustered source.
 *
 * Three things worth noting:
 *  - There is no `type` parameter. Which side you see is authorization, not a
 *    filter, and it is derived from the caller's own org inside the
 *    `organizations_near` function. Nothing in this URL can widen the result.
 *  - The response carries org-level fields only (CLAUDE.md architecture rule).
 *  - `no-store`: results depend on the caller's identity. A shared cache must
 *    never hold one org's view of the directory and serve it to another.
 *
 * Structured so an M7 rate-limit wrapper drops in around the handler body
 * without touching the query logic.
 */
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser();

  if (!user) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: NO_STORE },
    );
  }

  // Keyed by user, not IP: this route is authenticated, so the identity is
  // known and exact — an IP key would lump everyone behind one NAT together
  // and punish them for each other's traffic.
  //
  // Placed after the auth check so an unauthenticated flood can't consume a
  // real user's budget, and so the limiter never allocates a bucket for a
  // request that was going to be rejected anyway.
  const decision = mapQueryLimiter.check(user.id);
  if (rateLimitingEnabled() && !decision.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { ...NO_STORE, ...rateLimitHeaders(decision) },
      },
    );
  }

  const parsed = parseOrgsQuery(request.nextUrl.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query.",
        fieldErrors: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  const { near, radiusKm, q } = parsed.data;

  try {
    const orgs = await findCounterpartiesNear(
      {
        latitude: near.latitude,
        longitude: near.longitude,
        radiusKm,
        query: q,
      },
      { userId: user.id },
    );

    return NextResponse.json(toFeatureCollection(orgs), {
      // `no-store` still applies even though we cache server-side. The two are
      // different things: our cache is keyed by user and lives in this process,
      // while this header governs shared caches we do not control. A CDN
      // holding one org's view of the directory and replaying it to another is
      // exactly the leak the M3 review guarded against.
      headers: { ...NO_STORE, ...rateLimitHeaders(decision) },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not load the map right now." },
      { status: 500, headers: NO_STORE },
    );
  }
}
