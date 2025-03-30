import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchGeocodeResults, geocodeAddress } from "@/lib/geocode";

const sample = [
  {
    lat: "39.7817",
    lon: "-89.6501",
    display_name: "Springfield, Sangamon County, Illinois, USA",
  },
  {
    lat: "42.1015",
    lon: "-72.5898",
    display_name: "Springfield, Hampden County, Massachusetts, USA",
  },
];

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fetchGeocodeResults", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits Nominatim /search with the expected params and a User-Agent", async () => {
    const fetchFn = mockFetch(sample);

    await fetchGeocodeResults("Springfield");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0] as [URL, RequestInit];
    const url = new URL(String(call[0]));
    expect(url.origin + url.pathname).toBe(
      "https://nominatim.openstreetmap.org/search",
    );
    expect(url.searchParams.get("q")).toBe("Springfield");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("limit")).toBe("6");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/FoodForEveryone/);
  });

  it("maps entries to {label, latitude, longitude}", async () => {
    mockFetch(sample);
    await expect(fetchGeocodeResults("Springfield")).resolves.toEqual([
      {
        label: "Springfield, Sangamon County, Illinois, USA",
        latitude: 39.7817,
        longitude: -89.6501,
      },
      {
        label: "Springfield, Hampden County, Massachusetts, USA",
        latitude: 42.1015,
        longitude: -72.5898,
      },
    ]);
  });

  it("drops entries with non-numeric coordinates", async () => {
    mockFetch([{ lat: "abc", lon: "def", display_name: "Bad" }]);
    await expect(fetchGeocodeResults("a b c")).resolves.toEqual([]);
  });

  it("returns [] when the body is not an array", async () => {
    mockFetch({ error: "nope" });
    await expect(fetchGeocodeResults("a b c")).resolves.toEqual([]);
  });

  it("throws on a non-200 response", async () => {
    mockFetch("rate limited", 429);
    await expect(fetchGeocodeResults("a b c")).rejects.toThrow(/429/);
  });
});

describe("geocodeAddress", () => {
  it("short-circuits a too-short query without calling fetch", async () => {
    const fetchFn = mockFetch(sample);
    await expect(geocodeAddress("ab")).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
