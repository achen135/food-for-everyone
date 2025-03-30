import { describe, expect, it } from "vitest";

import {
  geocodeQuerySchema,
  needsFreshGeocode,
  organizationSchema,
} from "@/lib/validation/organization";

const valid = {
  name: "Springfield Community Kitchen",
  type: "donor" as const,
  description: "",
  email: "hello@kitchen.org",
  phone: "",
  website: "",
  address: "742 Evergreen Terrace, Springfield",
  latitude: 39.78,
  longitude: -89.65,
};

describe("organizationSchema", () => {
  it("accepts a minimal valid organization", () => {
    expect(organizationSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a name", () => {
    expect(organizationSchema.safeParse({ ...valid, name: "  " }).success).toBe(
      false,
    );
  });

  it("rejects an unknown type", () => {
    expect(
      organizationSchema.safeParse({ ...valid, type: "charity" }).success,
    ).toBe(false);
  });

  it("requires at least one of email or phone", () => {
    const result = organizationSchema.safeParse({
      ...valid,
      email: "",
      phone: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts phone-only contact", () => {
    expect(
      organizationSchema.safeParse({
        ...valid,
        email: "",
        phone: "(555) 123-4567",
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed email when provided", () => {
    expect(
      organizationSchema.safeParse({ ...valid, email: "not-an-email" }).success,
    ).toBe(false);
  });

  it("accepts a bare-host website (scheme added by the action)", () => {
    expect(
      organizationSchema.safeParse({ ...valid, website: "kitchen.org" })
        .success,
    ).toBe(true);
  });

  it("rejects a garbage website", () => {
    expect(
      organizationSchema.safeParse({ ...valid, website: "not a website" })
        .success,
    ).toBe(false);
  });

  it("requires an address", () => {
    expect(
      organizationSchema.safeParse({ ...valid, address: "" }).success,
    ).toBe(false);
  });

  it("allows null lat/lng (edit without re-searching)", () => {
    expect(
      organizationSchema.safeParse({
        ...valid,
        latitude: null,
        longitude: null,
      }).success,
    ).toBe(true);
  });

  it("rejects an out-of-range latitude", () => {
    expect(
      organizationSchema.safeParse({ ...valid, latitude: 120 }).success,
    ).toBe(false);
  });

  it("rejects a description over 2000 characters", () => {
    expect(
      organizationSchema.safeParse({ ...valid, description: "x".repeat(2001) })
        .success,
    ).toBe(false);
  });
});

describe("geocodeQuerySchema", () => {
  it("accepts a 3+ character query", () => {
    expect(geocodeQuerySchema.safeParse({ q: "123 Main St" }).success).toBe(
      true,
    );
  });

  it("rejects a too-short query", () => {
    expect(geocodeQuerySchema.safeParse({ q: "ab" }).success).toBe(false);
  });

  it("trims before length-checking", () => {
    expect(geocodeQuerySchema.safeParse({ q: "  a  " }).success).toBe(false);
  });
});

describe("needsFreshGeocode", () => {
  const coords = { latitude: 42.44, longitude: -76.5 };

  it("allows an edit that re-ran the search (coordinates present)", () => {
    expect(
      needsFreshGeocode({
        storedAddress: "Old St",
        inputAddress: "New Ave",
        ...coords,
      }),
    ).toBe(false);
  });

  it("allows an edit that left the address alone", () => {
    expect(
      needsFreshGeocode({
        storedAddress: "Old St",
        inputAddress: "Old St",
        latitude: null,
        longitude: null,
      }),
    ).toBe(false);
  });

  it("rejects a changed address with no fresh coordinates", () => {
    expect(
      needsFreshGeocode({
        storedAddress: "Old St",
        inputAddress: "Somewhere Else",
        latitude: null,
        longitude: null,
      }),
    ).toBe(true);
  });

  it("rejects a half-filled coordinate pair", () => {
    expect(
      needsFreshGeocode({
        storedAddress: "Old St",
        inputAddress: "Somewhere Else",
        latitude: 42.44,
        longitude: null,
      }),
    ).toBe(true);
  });

  it("treats a null stored address as empty", () => {
    expect(
      needsFreshGeocode({
        storedAddress: null,
        inputAddress: "Anywhere",
        latitude: null,
        longitude: null,
      }),
    ).toBe(true);
  });
});
