import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import { appCache, cacheKey, cachingEnabled } from "@/lib/cache";
import type {
  CounterpartyOrganization,
  LatLng,
  Organization,
  OrganizationType,
} from "@/lib/db/types";

/** Fields the organization form owns. `null` = clear; omit lat/lng to keep the stored point. */
export interface OrganizationWrite {
  name: string;
  type: OrganizationType;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Cache namespaces. Every key is prefixed with the owning user, which is what
 * makes the entries safe to hold at all — see `ORG_CACHE` below.
 */
const ORG_CACHE = {
  /** `org:<userId>` — the caller's own organization row. */
  own: (userId: string) => cacheKey("org", userId),
  /** `orgs:near:<userId>:<lat>:<lng>:<radiusKm>:<q>` — one map query. */
  near: (
    userId: string,
    lat: number,
    lng: number,
    radiusKm: number,
    query: string,
  ) => cacheKey("orgs:near", userId, lat, lng, radiusKm, query),
} as const;

/**
 * Short TTLs. These exist to collapse the bursts the UI actually produces — a
 * page load reading the org three times, a debounced search firing while a
 * realtime event triggers a refresh — not to hold data for minutes. The SWR
 * window means an expiry never makes a user wait for the database.
 */
const OWN_ORG_TTL = { ttlMs: 15_000, staleMs: 30_000 };
const NEAR_TTL = { ttlMs: 20_000, staleMs: 40_000 };

/** The caller's organization, or null if they haven't created one. */
export async function getMyOrganization(): Promise<Organization | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const read = async () => {
    const { data, error } = await tracked("organizations.selectByOwner", () =>
      supabase
        .from("organizations")
        .select("*")
        .eq("owner_id", user.id)
        .maybeSingle(),
    );
    if (error) throw error;
    return data;
  };

  if (!cachingEnabled()) return read();
  return appCache.get(ORG_CACHE.own(user.id), read, OWN_ORG_TTL);
}

/**
 * Drop every cached entry belonging to one user. Called after a write so the
 * author sees their own change immediately rather than up to a TTL later.
 *
 * Best-effort on serverless: it only clears the instance it runs on, and
 * another instance may still be holding the old value until it expires. That
 * is why the TTLs above are short — expiry, not invalidation, is what
 * guarantees convergence.
 */
export function invalidateOrganizationCache(userId: string): void {
  appCache.delete(ORG_CACHE.own(userId));
  appCache.deletePrefix(cacheKey("orgs:near", userId) + ":");
}

/**
 * Create or update the caller's organization (one per account — unique index on
 * owner_id). When `latitude`/`longitude` are null the `location` column is left
 * out of the write, so an edit that didn't re-search the address keeps its point.
 */
export async function upsertMyOrganization(
  userId: string,
  fields: OrganizationWrite,
): Promise<Organization> {
  const supabase = await createClient();

  const row: Record<string, unknown> = {
    owner_id: userId,
    name: fields.name,
    type: fields.type,
    description: fields.description,
    email: fields.email,
    phone: fields.phone,
    website: fields.website,
    address: fields.address,
  };
  if (fields.latitude !== null && fields.longitude !== null) {
    // geography(Point,4326): PostgREST casts this WKT string to the column type.
    row.location = `POINT(${fields.longitude} ${fields.latitude})`;
  }

  const { data, error } = await tracked("organizations.upsertByOwner", () =>
    supabase
      .from("organizations")
      .upsert(row, { onConflict: "owner_id" })
      .select("*")
      .single(),
  );
  if (error) throw error;
  return data;
}

/**
 * The caller's own coordinates, for centring the map. Goes through the
 * `my_organization_point` RPC because `location` is a geography column —
 * PostgREST returns hex EWKB for it on a plain select, so lat/lng are extracted
 * in SQL rather than decoded here.
 */
export async function getMyOrganizationPoint(): Promise<LatLng | null> {
  const supabase = await createClient();

  const { data, error } = await tracked("organizations.myPoint", () =>
    supabase.rpc("my_organization_point").maybeSingle(),
  );
  if (error) throw error;
  if (!data) return null;

  const point = data as { latitude: number; longitude: number };
  return { latitude: point.latitude, longitude: point.longitude };
}

export interface CounterpartySearch {
  latitude: number;
  longitude: number;
  radiusKm: number;
  /** Optional name filter. */
  query?: string;
}

/**
 * Counterparty organizations within `radiusKm` of a point, nearest first.
 *
 * Authorization is NOT expressed here: `organizations_near` is a security
 * definer function that derives the caller's counterparty type from
 * `auth.uid()`. Nothing this function passes can widen what comes back — the
 * arguments only narrow it. A caller with no organization gets an empty list.
 *
 * ## Why the cache key is per-user
 *
 * The results depend only on the caller's *type*, the centre, the radius and
 * the search term — two donors asking the same question get byte-identical
 * rows. So a key of `type:centre:radius:q`, shared across every donor, is
 * tempting and would raise the hit rate considerably.
 *
 * It is also unsafe, in a way worth spelling out. To build that key the app has
 * to know the caller's type, which means reading it — and any cached or
 * slightly stale read can disagree with what the function derives from
 * `auth.uid()` at query time. A user who has just switched donor → recipient
 * would store recipient-side rows under the `donor:` key, and every genuine
 * donor would then be served the wrong side of the exchange from cache. The
 * window is small; the failure is silent, shared, and serves one org's view to
 * another. That is the same shape of bug as M2's `profiles.organization_id`.
 *
 * Keying on `userId` removes the possibility rather than narrowing the window:
 * the key and the authorization derive from the same identity, so they cannot
 * disagree. It costs cross-user sharing and needs no extra read to build.
 * Sharing could be recovered safely by having the function return the type it
 * actually used and validating before storing — worth doing if hit rate ever
 * becomes the constraint, and not before.
 */
export async function findCounterpartiesNear(
  search: CounterpartySearch,
  options: { userId?: string } = {},
): Promise<CounterpartyOrganization[]> {
  const supabase = await createClient();
  const query = search.query?.trim() ?? "";

  const read = async () => {
    const { data, error } = await tracked("organizations.near", () =>
      supabase.rpc("organizations_near", {
        center_lat: search.latitude,
        center_lng: search.longitude,
        radius_km: search.radiusKm,
        search: query || null,
      }),
    );
    if (error) throw error;
    return (data ?? []) as CounterpartyOrganization[];
  };

  if (!cachingEnabled() || !options.userId) return read();

  return appCache.get(
    ORG_CACHE.near(
      options.userId,
      search.latitude,
      search.longitude,
      search.radiusKm,
      query,
    ),
    read,
    NEAR_TTL,
  );
}

export type { OrganizationType };
