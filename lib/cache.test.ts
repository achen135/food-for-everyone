import { describe, expect, it, vi } from "vitest";

import { ReadThroughCache, cacheKey } from "@/lib/cache";

function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

/** A fetcher that counts calls and resolves when told, so races are testable. */
function deferredFetcher<T>(value: T) {
  let calls = 0;
  let release: (() => void) | null = null;
  const fetcher = async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return value;
  };
  return {
    fetcher,
    get calls() {
      return calls;
    },
    resolve() {
      release?.();
    },
  };
}

const TTL = { ttlMs: 1000, staleMs: 1000 };

describe("ReadThroughCache", () => {
  it("fetches on a miss and serves the value from memory afterwards", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const fetcher = vi.fn().mockResolvedValue("value");

    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("value");
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("value");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("refetches once the entry is past both its fresh and stale windows", async () => {
    const clock = fakeClock();
    const cache = new ReadThroughCache({ now: clock.now });
    const fetcher = vi.fn().mockResolvedValue("v");

    await cache.get("k", fetcher, TTL);
    clock.advance(2001); // past ttl + stale
    await cache.get("k", fetcher, TTL);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serves stale immediately and refreshes behind the request", async () => {
    const clock = fakeClock();
    const cache = new ReadThroughCache({ now: clock.now });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    await cache.get("k", fetcher, TTL);
    clock.advance(1500); // stale, but inside the SWR window

    // The point of SWR: the caller is not made to wait for the refresh.
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("first");
    expect(cache.stats().staleHits).toBe(1);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("second");
  });

  it("keeps serving the stale value when the background refresh fails", async () => {
    const clock = fakeClock();
    const cache = new ReadThroughCache({ now: clock.now });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("good")
      .mockRejectedValue(new Error("database down"));

    await cache.get("k", fetcher, TTL);
    clock.advance(1500);

    // A failed refresh must not surface as an error on a request we already
    // answered, and must not evict the last good value.
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("good");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("good");
  });

  it("collapses concurrent misses into a single fetch", async () => {
    // The stampede case: without this a cold cache turns N concurrent readers
    // into N identical queries at exactly the worst moment.
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const d = deferredFetcher("value");

    const inFlight = Array.from({ length: 25 }, () =>
      cache.get("k", d.fetcher, TTL),
    );
    d.resolve();
    const results = await Promise.all(inFlight);

    expect(d.calls).toBe(1);
    expect(results.every((r) => r === "value")).toBe(true);
    expect(cache.stats().coalesced).toBe(24);
  });

  it("does not cache a rejection — the next caller gets a fresh attempt", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");

    await expect(cache.get("k", fetcher, TTL)).rejects.toThrow("transient");
    await expect(cache.get("k", fetcher, TTL)).resolves.toBe("recovered");
  });

  it("keeps keys independent", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const a = vi.fn().mockResolvedValue("A");
    const b = vi.fn().mockResolvedValue("B");

    await expect(cache.get("a", a, TTL)).resolves.toBe("A");
    await expect(cache.get("b", b, TTL)).resolves.toBe("B");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("evicts least-recently-used entries past the size limit", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now, maxEntries: 3 });
    const f = (v: string) => vi.fn().mockResolvedValue(v);

    await cache.get("a", f("a"), TTL);
    await cache.get("b", f("b"), TTL);
    await cache.get("c", f("c"), TTL);
    await cache.get("a", f("a2"), TTL); // touch "a" — now "b" is oldest
    await cache.get("d", f("d"), TTL); // evicts "b"

    expect(cache.stats().size).toBe(3);
    expect(cache.stats().evictions).toBe(1);

    const bAgain = vi.fn().mockResolvedValue("b-refetched");
    await expect(cache.get("b", bAgain, TTL)).resolves.toBe("b-refetched");
    expect(bAgain).toHaveBeenCalledTimes(1);

    // "a" survived because reading it marked it recently used.
    const aAgain = vi.fn().mockResolvedValue("should-not-run");
    await expect(cache.get("a", aAgain, TTL)).resolves.toBe("a");
    expect(aAgain).not.toHaveBeenCalled();
  });

  it("delete forces the next read to refetch", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const fetcher = vi.fn().mockResolvedValue("v");

    await cache.get("k", fetcher, TTL);
    cache.delete("k");
    await cache.get("k", fetcher, TTL);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deletePrefix clears one namespace and leaves the rest", async () => {
    const cache = new ReadThroughCache({ now: fakeClock().now });
    const f = vi.fn().mockResolvedValue("v");

    await cache.get("orgs:near:user-1:a", f, TTL);
    await cache.get("orgs:near:user-1:b", f, TTL);
    await cache.get("orgs:near:user-2:a", f, TTL);
    expect(f).toHaveBeenCalledTimes(3);

    cache.deletePrefix("orgs:near:user-1:");

    await cache.get("orgs:near:user-2:a", f, TTL); // still cached
    expect(f).toHaveBeenCalledTimes(3);
    await cache.get("orgs:near:user-1:a", f, TTL); // cleared
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("treats staleMs of 0 as no SWR window", async () => {
    const clock = fakeClock();
    const cache = new ReadThroughCache({ now: clock.now });
    const fetcher = vi.fn().mockResolvedValue("v");

    await cache.get("k", fetcher, { ttlMs: 1000 });
    clock.advance(1001);
    await cache.get("k", fetcher, { ttlMs: 1000 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.stats().staleHits).toBe(0);
  });
});

describe("cacheKey", () => {
  it("joins parts with colons", () => {
    expect(cacheKey("orgs:near", "u1", 41.88, -87.63, 25, "")).toBe(
      "orgs:near:u1:41.88:-87.63:25:",
    );
  });

  it("collapses null and undefined to the same empty segment", () => {
    // "no search term" must be one key, not three.
    expect(cacheKey("a", null, "b")).toBe(cacheKey("a", undefined, "b"));
  });

  it("keeps different values in different keys", () => {
    expect(cacheKey("orgs", "u1", 25)).not.toBe(cacheKey("orgs", "u1", 50));
  });
});
