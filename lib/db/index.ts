/**
 * The data-access layer. Route Handlers, Server Actions, and Server Components
 * import from here — never `@/lib/supabase/server` directly for queries — so
 * that every DB call passes through `tracked()` (see ./instrument).
 */

export { getReadCount, resetReadCount, tracked } from "@/lib/db/instrument";
export { getMyProfile, getOrCreateProfile } from "@/lib/db/profiles";
export type { Organization, OrganizationType, Profile } from "@/lib/db/types";
