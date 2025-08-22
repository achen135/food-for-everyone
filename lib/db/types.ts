/**
 * Hand-written row types for the tables this milestone touches.
 *
 * TODO (M2+): replace with generated types via
 *   `npx supabase gen types typescript --local > lib/db/database.types.ts`
 * once the schema settles and the local Supabase stack is wired up.
 */

export type OrganizationType = "donor" | "recipient";

export interface Profile {
  id: string;
  full_name: string | null;
  /**
   * Read-only demo account flag (M6 migration). Enforced server-side in every
   * write path — `saveOrganizationAction` and the M6 listing/claim actions —
   * never by hiding UI. See the M4 demo-login checkpoint in Spec §10.
   */
  is_demo: boolean;
  created_at: string;
}

export interface Organization {
  id: string;
  owner_id: string;
  name: string;
  type: OrganizationType;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  /** PostGIS geography(Point,4326); serialized as GeoJSON when selected explicitly. */
  location: string | null;
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * `listings.status`. Note there is no `expired` — expiry is derived from
 * `pickup_end`, not stored (see the M6 migration header for why).
 */
export type ListingStatus = "open" | "claimed" | "completed" | "cancelled";

/**
 * Waste-risk tier from the ML subsystem (M14), written by `python -m ml.batch`.
 *
 * Mirrors the check constraint on `public.listing_risk.risk_tier`. The tier is
 * a bucketing of a calibrated probability at two thresholds placed on the
 * `val_op` split — see `ml/model/model_card.json`, not a raw score, because a
 * probability on a listing card invites a precision the model does not have.
 */
export type RiskTier = "low" | "medium" | "high";

/**
 * Result codes returned by the M6 write functions. They return a code instead
 * of raising so that user-facing copy lives in TypeScript and every branch is
 * easy to test. Keep in step with the migration.
 */
export type ListingActionCode =
  | "ok"
  | "no_organization"
  | "not_donor"
  | "not_recipient"
  | "demo_account"
  | "not_found"
  | "not_open"
  | "not_claimed"
  | "no_claim"
  | "expired"
  | "already_claimed"
  | "bad_window";

/** One row of `browse_open_listings` — what a recipient sees on offer. */
export interface OpenListing {
  id: string;
  title: string;
  quantity: string;
  pickup_start: string;
  pickup_end: string;
  notes: string | null;
  status: ListingStatus;
  created_at: string;
  donor_name: string;
  donor_address: string | null;
  donor_email: string | null;
  donor_phone: string | null;
  donor_verified: boolean;
  distance_km: number;
  claimed_by_me: boolean;
}

/** One row of `my_listings` — a donor's own listing plus who holds it. */
export interface MyListing {
  id: string;
  title: string;
  quantity: string;
  pickup_start: string;
  pickup_end: string;
  notes: string | null;
  status: ListingStatus;
  created_at: string;
  claimant_name: string | null;
  claimant_email: string | null;
  claimant_phone: string | null;
  claimed_at: string | null;
}

/** One row of `my_claims` — a recipient's live claim plus the donor's details. */
export interface MyClaim {
  id: string;
  listing_id: string;
  title: string;
  quantity: string;
  pickup_start: string;
  pickup_end: string;
  notes: string | null;
  status: ListingStatus;
  claimed_at: string;
  donor_name: string;
  donor_address: string | null;
  donor_email: string | null;
  donor_phone: string | null;
}

// ------------------------------------------------------------- M8 analytics

/**
 * `network_overview()` — network-wide counts. Aggregate only: no organization
 * is named and no coordinate is returned, which is what makes it safe to show
 * to any signed-in caller. See the M8 migration header for the per-metric
 * global-vs-scoped decision.
 */
export interface NetworkOverview {
  donor_orgs: number;
  recipient_orgs: number;
  total_listings: number;
  /** Open *and* still collectable — expiry is derived, never stored. */
  open_listings: number;
  claimed_listings: number;
  completed_listings: number;
  active_claims: number;
}

/** One gap-filled day of `network_activity_daily`. `day` is a UTC date. */
export interface NetworkActivityDay {
  day: string;
  posted: number;
  completed: number;
}

/** One distance band of `network_reach`. */
export interface NetworkReachBand {
  bucket: string;
  bucket_order: number;
  donations: number;
}

/**
 * `my_activity_summary()` — the caller's own organization.
 *
 * Both halves are always present; in practice a donor's claim counts are zero
 * and a recipient's listing counts are, because `create_listing` requires a
 * donor and `claim_listing` a recipient. `role` says which half to read.
 *
 * `fulfilment_rate` is a percentage, or null when nothing has finished yet.
 * The numerator and denominator come with it so the UI can show the fraction
 * behind the percentage rather than asking the reader to trust it.
 */
export interface MyActivitySummary {
  role: OrganizationType;
  listings_posted: number;
  listings_open: number;
  listings_expired: number;
  listings_claimed: number;
  listings_completed: number;
  listings_cancelled: number;
  claims_made: number;
  claims_active: number;
  claims_completed: number;
  claims_released: number;
  fulfilment_numerator: number;
  fulfilment_denominator: number;
  fulfilment_rate: number | null;
}

/** One gap-filled day of `my_activity_daily`. */
export interface MyActivityDay {
  day: string;
  listings_posted: number;
  listings_completed: number;
  claims_made: number;
  claims_completed: number;
}

/**
 * One row from the `organizations_near` RPC — what a counterparty is allowed to
 * see. Deliberately narrower than `Organization`: no `owner_id`, no timestamps,
 * and nothing about the person who registered the org (CLAUDE.md architecture
 * rule). Keep this in step with the function's `returns table (...)`.
 */
export interface CounterpartyOrganization {
  id: string;
  name: string;
  type: OrganizationType;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  verified: boolean;
  latitude: number;
  longitude: number;
  distance_km: number;
}
