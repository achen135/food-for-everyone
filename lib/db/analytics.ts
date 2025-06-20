import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import type {
  MyActivityDay,
  MyActivitySummary,
  NetworkActivityDay,
  NetworkOverview,
  NetworkReachBand,
} from "@/lib/db/types";

/**
 * Dashboard aggregates (M8).
 *
 * Every read is a `security definer` function with an explicit return shape —
 * the M3 pattern. None of them takes an argument that widens what comes back:
 * the two `my*` functions derive the organization from `auth.uid()`, and the
 * three `network*` ones return counts that are the same for every caller.
 *
 * ## Why none of this is cached
 *
 * M7 shipped a read-through cache and the M8 brief expected these aggregates to
 * be its next customer — "expensive, tolerant of a few seconds' staleness".
 * Measured on the seeded database (263 listings, 194 claims), all five together
 * cost **~1.9 ms**: overview 0.13, activity 0.22, reach 0.94, summary 0.19,
 * own-activity 0.40. That is the same shape of finding as M7's own: the map
 * query it cached runs in 0.72 ms while the request around it spends ~28 ms in
 * two GoTrue round-trips. The database is not what makes this page slow.
 *
 * Against that ~1.9 ms, a cache would cost the feature the milestone is
 * actually about. The dashboard re-reads on a Realtime event; a cached read
 * would answer that refresh with the numbers that were already on screen and
 * hold them for the rest of the TTL — a live dashboard that quietly lies for
 * several seconds after every change, which is worse than a slow one.
 *
 * So the cache stays where it was measured to help. If these aggregates ever
 * scan enough rows to matter, the fix is a cache keyed per organization *and*
 * busted by the same event that triggers the refetch — not a TTL, which is the
 * one thing that cannot be reconciled with live updates. The key would have to
 * carry the caller's identity: these results are per-organization, and a shared
 * key would serve one org's fulfilment rate to another. See
 * `lib/db/organizations.ts` for that reasoning worked through on the map query.
 */

/** Network-wide counts. Aggregate only — nothing here identifies an org. */
export async function getNetworkOverview(): Promise<NetworkOverview | null> {
  const supabase = await createClient();
  const { data, error } = await tracked("analytics.networkOverview", () =>
    supabase.rpc("network_overview").maybeSingle(),
  );
  if (error) throw error;
  return (data as NetworkOverview | null) ?? null;
}

/** Posted and completed per day, gap-filled, oldest first. */
export async function getNetworkActivityDaily(
  days = 90,
): Promise<NetworkActivityDay[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("analytics.networkActivityDaily", () =>
    supabase.rpc("network_activity_daily", { p_days: days }),
  );
  if (error) throw error;
  return (data ?? []) as NetworkActivityDay[];
}

/** Completed donations bucketed by how far the food travelled. */
export async function getNetworkReach(): Promise<NetworkReachBand[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("analytics.networkReach", () =>
    supabase.rpc("network_reach"),
  );
  if (error) throw error;
  return (data ?? []) as NetworkReachBand[];
}

/**
 * The caller's own totals, or null when they have no organization yet — the
 * function returns no rows in that case, which is the same signal the listings
 * page uses to show its setup prompt.
 */
export async function getMyActivitySummary(): Promise<MyActivitySummary | null> {
  const supabase = await createClient();
  const { data, error } = await tracked("analytics.myActivitySummary", () =>
    supabase.rpc("my_activity_summary").maybeSingle(),
  );
  if (error) throw error;
  if (!data) return null;

  const row = data as MyActivitySummary;
  return {
    ...row,
    // `fulfilment_rate` is a Postgres `numeric`. PostgREST serialises it
    // faithfully rather than as a float, so it can arrive as a string; coerce
    // once here instead of at every call site.
    fulfilment_rate:
      row.fulfilment_rate === null ? null : Number(row.fulfilment_rate),
  };
}

/** The caller's own daily series, gap-filled, oldest first. */
export async function getMyActivityDaily(days = 90): Promise<MyActivityDay[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("analytics.myActivityDaily", () =>
    supabase.rpc("my_activity_daily", { p_days: days }),
  );
  if (error) throw error;
  return (data ?? []) as MyActivityDay[];
}
