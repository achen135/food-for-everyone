import type { CounterpartyOrganization } from "@/lib/db/types";

/**
 * Minimal GeoJSON shapes, declared here rather than pulled from `@types/geojson`
 * (which reaches us only transitively through maplibre-gl). This is the exact
 * contract between `/api/orgs` and the map's clustered source.
 */

export interface OrgFeatureProperties {
  id: string;
  name: string;
  type: CounterpartyOrganization["type"];
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  verified: boolean;
  distanceKm: number;
}

export interface OrgFeature {
  type: "Feature";
  /** GeoJSON is [longitude, latitude] — the opposite order to how we say it. */
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: OrgFeatureProperties;
}

export interface OrgFeatureCollection {
  type: "FeatureCollection";
  features: OrgFeature[];
}

export function toFeature(org: CounterpartyOrganization): OrgFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [org.longitude, org.latitude] },
    properties: {
      id: org.id,
      name: org.name,
      type: org.type,
      description: org.description,
      email: org.email,
      phone: org.phone,
      website: org.website,
      address: org.address,
      verified: org.verified,
      distanceKm: Math.round(org.distance_km * 10) / 10,
    },
  };
}

export function toFeatureCollection(
  orgs: CounterpartyOrganization[],
): OrgFeatureCollection {
  return { type: "FeatureCollection", features: orgs.map(toFeature) };
}

export const EMPTY_FEATURE_COLLECTION: OrgFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
