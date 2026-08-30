import "server-only";

import { unstable_cache } from "next/cache";

/**
 * Address → coordinates via OpenStreetMap Nominatim.
 *
 * Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 *   - no per-keystroke autocomplete — this is only ever called from an explicit
 *     "Search address" action (see app/app/organization/actions.ts);
 *   - identify the app with a real User-Agent;
 *   - cache results — every lookup goes through `unstable_cache` below, so a
 *     repeated query never re-hits Nominatim;
 *   - ≤ 1 request/second — search-triggered + cached keeps portfolio traffic far
 *     under this without an explicit throttle.
 * Fallback if limits ever bite: Photon (komoot), then self-hosted — see
 * docs/Design Decisions.md.
 *
 * The Postgres-backed read-through cache is deliberately NOT built here; that is
 * an M7 deliverable (Spec §9). `unstable_cache` is the interim store.
 */

const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  "FoodForEveryone/0.2 (+https://github.com/achen135/food-for-everyone)";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESULTS = 6;
const MIN_QUERY_LENGTH = 3;

export interface GeocodeResult {
  /** Full human-readable address from the geocoder. */
  label: string;
  latitude: number;
  longitude: number;
}

/** Raw Nominatim `/search` response entries we care about. */
interface NominatimEntry {
  lat: string;
  lon: string;
  display_name: string;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The un-cached fetch + map. Exported for tests; app code should call
 * `geocodeAddress`.
 */
export async function fetchGeocodeResults(
  query: string,
): Promise<GeocodeResult[]> {
  const url = new URL(NOMINATIM_SEARCH);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", String(MAX_RESULTS));

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Nominatim responded ${response.status}`);
  }

  const entries = (await response.json()) as NominatimEntry[];
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => ({
      label: entry.display_name,
      latitude: Number(entry.lat),
      longitude: Number(entry.lon),
    }))
    .filter(
      (r) =>
        r.label.length > 0 &&
        Number.isFinite(r.latitude) &&
        Number.isFinite(r.longitude),
    );
}

const cachedGeocode = unstable_cache(
  (query: string) => fetchGeocodeResults(query),
  ["geocode-search-v1"],
  { revalidate: CACHE_TTL_SECONDS, tags: ["geocode"] },
);

/**
 * Geocode an address string to a short list of candidate matches. Returns `[]`
 * for a too-short query. Throws if Nominatim is unreachable / errors — the
 * caller turns that into a user-facing message.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult[]> {
  const normalized = normalizeQuery(query);
  if (normalized.length < MIN_QUERY_LENGTH) return [];
  return cachedGeocode(normalized);
}
