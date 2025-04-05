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
