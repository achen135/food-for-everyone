import { describe, expect, it } from "vitest";

import {
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
  parseOrgsQuery,
} from "@/lib/validation/map";

const params = (init: Record<string, string>) =>
  new URLSearchParams(init satisfies Record<string, string>);

describe("parseOrgsQuery", () => {
  it("parses a full query", () => {
    const result = parseOrgsQuery(
      params({ near: "41.88,-87.63", radiusKm: "10", q: "pantry" }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.near).toEqual({ latitude: 41.88, longitude: -87.63 });
    expect(result.data.radiusKm).toBe(10);
    expect(result.data.q).toBe("pantry");
  });

  it("defaults the radius when absent", () => {
    const result = parseOrgsQuery(params({ near: "41.88,-87.63" }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.radiusKm).toBe(DEFAULT_RADIUS_KM);
  });

  it("falls back to the default for an out-of-range radius", () => {
    const result = parseOrgsQuery(
      params({ near: "41.88,-87.63", radiusKm: String(MAX_RADIUS_KM + 1000) }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.radiusKm).toBe(DEFAULT_RADIUS_KM);
  });

  it("falls back to the default for a non-numeric radius", () => {
    const result = parseOrgsQuery(
      params({ near: "41.88,-87.63", radiusKm: "all of them" }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.radiusKm).toBe(DEFAULT_RADIUS_KM);
  });

  it("rejects a missing `near`", () => {
    expect(parseOrgsQuery(params({})).success).toBe(false);
  });

  it("rejects a malformed `near`", () => {
    expect(parseOrgsQuery(params({ near: "41.88" })).success).toBe(false);
    expect(parseOrgsQuery(params({ near: "a,b" })).success).toBe(false);
    expect(parseOrgsQuery(params({ near: "41.88,-87.63,5" })).success).toBe(
      false,
    );
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseOrgsQuery(params({ near: "91,-87.63" })).success).toBe(false);
    expect(parseOrgsQuery(params({ near: "41.88,-181" })).success).toBe(false);
  });

  it("accepts the poles and the antimeridian", () => {
    expect(parseOrgsQuery(params({ near: "90,180" })).success).toBe(true);
    expect(parseOrgsQuery(params({ near: "-90,-180" })).success).toBe(true);
  });

  it("rejects an over-long search string", () => {
    const result = parseOrgsQuery(
      params({ near: "41.88,-87.63", q: "x".repeat(201) }),
    );
    expect(result.success).toBe(false);
  });

  it("ignores an unknown `type` parameter — the side you see is authorization", () => {
    const result = parseOrgsQuery(
      params({ near: "41.88,-87.63", type: "donor" }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty("type");
  });
});
