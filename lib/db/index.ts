/**
 * The data-access layer. Route Handlers, Server Actions, and Server Components
 * import from here — never `@/lib/supabase/server` directly for queries — so
 * that every DB call passes through `tracked()` (see ./instrument).
 */

export { getReadCount, resetReadCount, tracked } from "@/lib/db/instrument";
export { getMyProfile, getOrCreateProfile } from "@/lib/db/profiles";
export {
  findCounterpartiesNear,
  getMyOrganization,
  getMyOrganizationPoint,
  invalidateOrganizationCache,
  upsertMyOrganization,
  type CounterpartySearch,
  type OrganizationWrite,
} from "@/lib/db/organizations";
export {
  browseOpenListings,
  cancelListing,
  claimListing,
  completeListing,
  createListing,
  getMyClaims,
  getMyListings,
  releaseClaim,
  type BrowseParams,
  type CreateListingInput,
} from "@/lib/db/listings";
export type {
  CounterpartyOrganization,
  LatLng,
  ListingActionCode,
  ListingStatus,
  MyClaim,
  MyListing,
  OpenListing,
  Organization,
  OrganizationType,
  Profile,
} from "@/lib/db/types";
