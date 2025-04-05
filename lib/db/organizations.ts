import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
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

/** The caller's organization, or null if they haven't created one. */
export async function getMyOrganization(): Promise<Organization | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await tracked("organizations.selectByOwner", () =>
    supabase
      .from("organizations")
      .select("*")
      .eq("owner_id", user.id)
      .maybeSingle(),
  );
  if (error) throw error;
  return data;
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
 */
export async function findCounterpartiesNear(
  search: CounterpartySearch,
): Promise<CounterpartyOrganization[]> {
  const supabase = await createClient();

  const { data, error } = await tracked("organizations.near", () =>
    supabase.rpc("organizations_near", {
      center_lat: search.latitude,
      center_lng: search.longitude,
      radius_km: search.radiusKm,
      search: search.query?.trim() || null,
    }),
  );
  if (error) throw error;
  return (data ?? []) as CounterpartyOrganization[];
}

export type { OrganizationType };
