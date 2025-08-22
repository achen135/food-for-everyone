import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import { mlRiskEscalationEnabled } from "@/lib/env";
import type { RiskTier } from "@/lib/db/types";

/**
 * Waste-risk tiers from the ML subsystem (M14).
 *
 * `public.listing_risk` is written by `python -m ml.batch` on a schedule and is
 * the only ml table the app reads. See `docs/ML Subsystem.md` §5 and
 * `ml/src/ml/batch/writeback.py`.
 *
 * ## This read fails silently, on purpose
 *
 * Every one of these is a normal state, and all of them render exactly as the
 * page did before M14:
 *
 *   - the feature flag is off (the default);
 *   - the migration has not been applied to this environment yet;
 *   - the batch job has never run, or has not run since these listings opened;
 *   - the listing is not currently open, so `prune` removed its row;
 *   - PostgREST errors for any other reason.
 *
 * A model-derived hint is strictly additive to a donor's own listings page. If
 * the ML subsystem is down, the right behaviour is for nobody to notice — a
 * toast saying "could not load risk scores" would be worse than useless, since
 * there is no action a donor could take about it. So this returns an empty map
 * rather than throwing, and the caller renders no badges.
 *
 * ## The flag is UX, not access control
 *
 * `mlRiskEscalationEnabled()` decides whether to *ask*. It is not a boundary:
 * the anon key ships to the browser and PostgREST is reachable directly, so
 * what actually protects this data is the RLS policy on `listing_risk`, which
 * admits a row only when the caller owns the listing it describes
 * (`20260910203000_listing_risk.sql`). This project has been bitten twice by
 * treating an application-side guard as a fence — see CLAUDE.md.
 */
export type ListingRiskMap = ReadonlyMap<string, RiskTier>;

const EMPTY: ListingRiskMap = new Map();

/**
 * Risk tiers for the given listings, keyed by listing id.
 *
 * Batched into one query rather than one per listing: the listings page renders
 * a donor's whole active set, and a per-row lookup would turn a single indexed
 * read into N of them behind `tracked()`.
 */
export async function getListingRiskTiers(
  listingIds: readonly string[],
): Promise<ListingRiskMap> {
  if (!mlRiskEscalationEnabled() || listingIds.length === 0) return EMPTY;

  try {
    const supabase = await createClient();
    const { data, error } = await tracked("listingRisk.byListingIds", () =>
      supabase
        .from("listing_risk")
        .select("listing_id, risk_tier")
        .in("listing_id", [...listingIds]),
    );
    if (error) return EMPTY;

    const tiers = new Map<string, RiskTier>();
    for (const row of data ?? []) {
      const tier = row.risk_tier;
      // Guard the value rather than trusting it: the column has a check
      // constraint, but this row was written by a different subsystem through
      // a different key, and an unrecognised tier must not reach the UI.
      if (tier === "low" || tier === "medium" || tier === "high") {
        tiers.set(row.listing_id as string, tier);
      }
    }
    return tiers;
  } catch {
    // The table may not exist in this environment at all — a preview deploy or
    // a local database that has not run the M14 migration. Absent is a state
    // this feature is designed to have.
    return EMPTY;
  }
}
