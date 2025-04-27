import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import type {
  ListingActionCode,
  MyClaim,
  MyListing,
  OpenListing,
} from "@/lib/db/types";

/**
 * Listings and claims.
 *
 * Every write is a `security definer` function that validates the state
 * transition and returns a result code — the tables themselves have no write
 * policies, so there is no other path in. See the M6 migration header.
 */

function asCode(value: unknown): ListingActionCode {
  return typeof value === "string" ? (value as ListingActionCode) : "not_found";
}

// ---------------------------------------------------------------- reads

export interface BrowseParams {
  radiusKm?: number;
  query?: string;
}

/** Open listings a recipient can still claim, nearest first. */
export async function browseOpenListings(
  params: BrowseParams = {},
): Promise<OpenListing[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.browseOpen", () =>
    supabase.rpc("browse_open_listings", {
      radius_km: params.radiusKm ?? 50,
      search: params.query?.trim() || null,
    }),
  );
  if (error) throw error;
  return (data ?? []) as OpenListing[];
}

/** A donor's own listings, with whoever currently holds each one. */
export async function getMyListings(): Promise<MyListing[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.mine", () =>
    supabase.rpc("my_listings"),
  );
  if (error) throw error;
  return (data ?? []) as MyListing[];
}

/** A recipient's live claims, with the donor's contact details. */
export async function getMyClaims(): Promise<MyClaim[]> {
  const supabase = await createClient();
  const { data, error } = await tracked("claims.mine", () =>
    supabase.rpc("my_claims"),
  );
  if (error) throw error;
  return (data ?? []) as MyClaim[];
}

// ---------------------------------------------------------------- writes

export interface CreateListingInput {
  title: string;
  quantity: string;
  /** ISO instants. */
  pickupStart: string;
  pickupEnd: string;
  notes: string | null;
}

export async function createListing(
  input: CreateListingInput,
): Promise<ListingActionCode> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.create", () =>
    supabase.rpc("create_listing", {
      p_title: input.title,
      p_quantity: input.quantity,
      p_pickup_start: input.pickupStart,
      p_pickup_end: input.pickupEnd,
      p_notes: input.notes,
    }),
  );
  if (error) throw error;
  return asCode(data);
}

/** Racy by nature — the function locks the row and one caller wins. */
export async function claimListing(
  listingId: string,
): Promise<ListingActionCode> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.claim", () =>
    supabase.rpc("claim_listing", { p_listing_id: listingId }),
  );
  if (error) throw error;
  return asCode(data);
}

export async function releaseClaim(
  listingId: string,
): Promise<ListingActionCode> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.release", () =>
    supabase.rpc("release_claim", { p_listing_id: listingId }),
  );
  if (error) throw error;
  return asCode(data);
}

export async function completeListing(
  listingId: string,
): Promise<ListingActionCode> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.complete", () =>
    supabase.rpc("complete_listing", { p_listing_id: listingId }),
  );
  if (error) throw error;
  return asCode(data);
}

export async function cancelListing(
  listingId: string,
): Promise<ListingActionCode> {
  const supabase = await createClient();
  const { data, error } = await tracked("listings.cancel", () =>
    supabase.rpc("cancel_listing", { p_listing_id: listingId }),
  );
  if (error) throw error;
  return asCode(data);
}
