import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Identity, so the pacer wiring underneath is observable. The cache's own
// behaviour is Next's to test; what matters here is what it wraps.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { fetchGeocodeResults, geocodeAddress } from "@/lib/geocode";
import { OutboundPaceSaturatedError, nominatimPacer } from "@/lib/pace";

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

describe("geocodeAddress outbound pacing", () => {
  beforeEach(() => {
    nominatimPacer.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    nominatimPacer.reset();
  });

  it("routes a cache miss through the process-global pacer", async () => {
    // The regression this guards: `unstable_cache` alone is not a throttle.
    // Distinct queries miss every time, which is exactly what a user typing
    // new addresses produces, so the pacer has to sit on the miss path.
    mockFetch(sample);
    const run = vi.spyOn(nominatimPacer, "run");

    await geocodeAddress("Springfield");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not pace a query that never reaches the network", async () => {
    mockFetch(sample);
    const run = vi.spyOn(nominatimPacer, "run");

    await geocodeAddress("ab");

    expect(run).not.toHaveBeenCalled();
  });

  it("propagates saturation instead of returning an empty list", async () => {
    mockFetch(sample);
    vi.spyOn(nominatimPacer, "run").mockRejectedValue(
      new OutboundPaceSaturatedError(4000),
    );

    // Callers distinguish this from a real "nothing found"; collapsing it into
    // `[]` here would make that impossible upstream.
    await expect(geocodeAddress("Springfield")).rejects.toBeInstanceOf(
      OutboundPaceSaturatedError,
    );
  });
});
