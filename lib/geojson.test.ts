import { describe, expect, it } from "vitest";

import type { CounterpartyOrganization } from "@/lib/db/types";
import { toFeature, toFeatureCollection } from "@/lib/geojson";

const org: CounterpartyOrganization = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Lakeside Harvest Pantry",
  type: "recipient",
  description: "Neighbourhood pantry.",
  email: "hello@example.invalid",
  phone: "(312) 555-0102",
  website: "https://example.invalid",
  address: "5700 S Lake Shore Dr, Chicago",
  verified: true,
  latitude: 41.7907492,
  longitude: -87.582931,
  distance_km: 8.4567,
};

describe("toFeature", () => {
  it("emits GeoJSON coordinates as [longitude, latitude]", () => {
    // The single easiest thing to get backwards in a mapping feature.
    expect(toFeature(org).geometry).toEqual({
      type: "Point",
      coordinates: [-87.582931, 41.7907492],
    });
  });

  it("carries the org-level fields through", () => {
    expect(toFeature(org).properties).toMatchObject({
      id: org.id,
      name: org.name,
      type: "recipient",
      email: org.email,
      phone: org.phone,
      website: org.website,
      address: org.address,
      verified: true,
    });
  });

  it("rounds the distance to one decimal place", () => {
    expect(toFeature(org).properties.distanceKm).toBe(8.5);
  });

  it("exposes nothing beyond the agreed property set", () => {
    // Data-minimisation rule (CLAUDE.md): map responses are org-level only.
    // If a field is added to the RPC, this test should be the thing that fails.
    expect(Object.keys(toFeature(org).properties).sort()).toEqual([
      "address",
      "description",
      "distanceKm",
      "email",
      "id",
      "name",
      "phone",
      "type",
      "verified",
      "website",
    ]);
  });

  it("preserves nulls rather than inventing empty strings", () => {
    const sparse = { ...org, description: null, phone: null, website: null };
    const props = toFeature(sparse).properties;
    expect(props.description).toBeNull();
    expect(props.phone).toBeNull();
    expect(props.website).toBeNull();
  });
});

describe("toFeatureCollection", () => {
  it("wraps features in a FeatureCollection", () => {
    const collection = toFeatureCollection([org, { ...org, id: "b" }]);
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(2);
  });

  it("handles an empty result", () => {
    expect(toFeatureCollection([])).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });
});
