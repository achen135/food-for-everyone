/**
 * The data-access layer. Route Handlers, Server Actions, and Server Components
 * import from here — never `@/lib/supabase/server` directly for queries — so
 * that every DB call passes through `tracked()` (see ./instrument).
 */

export { getReadCount, resetReadCount, tracked } from "@/lib/db/instrument";
export {
  getMyActivityDaily,
  getMyActivitySummary,
  getNetworkActivityDaily,
  getNetworkOverview,
  getNetworkReach,
} from "@/lib/db/analytics";
export { getMyProfile, getOrCreateProfile } from "@/lib/db/profiles";
export {
  getListingRiskTiers,
  type ListingRiskMap,
} from "@/lib/db/listing-risk";
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
  MyActivityDay,
  MyActivitySummary,
  MyClaim,
  MyListing,
  NetworkActivityDay,
  NetworkOverview,
  NetworkReachBand,
  OpenListing,
  Organization,
  OrganizationType,
  Profile,
  RiskTier,
} from "@/lib/db/types";
