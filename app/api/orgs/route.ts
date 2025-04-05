import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { findCounterpartiesNear } from "@/lib/db";
import { toFeatureCollection } from "@/lib/geojson";
import { createClient } from "@/lib/supabase/server";
import { parseOrgsQuery } from "@/lib/validation/map";

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = parseOrgsQuery(request.nextUrl.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query.",
        fieldErrors: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { near, radiusKm, q } = parsed.data;

  try {
    const orgs = await findCounterpartiesNear({
      latitude: near.latitude,
      longitude: near.longitude,
      radiusKm,
      query: q,
    });

    return NextResponse.json(toFeatureCollection(orgs), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not load the map right now." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
