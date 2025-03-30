import "server-only";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import type { Organization, OrganizationType } from "@/lib/db/types";

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

export type { OrganizationType };
