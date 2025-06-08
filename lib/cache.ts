/**
 * In-process read-through cache with TTL and stale-while-revalidate (Spec §9, M7).
 *
 * Three behaviours, and each earns its place:
 *
 *   **TTL** — an entry is *fresh* for `ttlMs` and served straight from memory.
 *
 *   **Stale-while-revalidate** — for `staleMs` after that it is still served,
 *   immediately, while a refresh runs in the background. The point is that
 *   expiry stops being a latency cliff: without it, every entry's expiry makes
 *   one unlucky request wait for the database.
 *
 *   **Single-flight** — concurrent misses on the same key share one fetch.
 *   This is the one that matters most under load. Without it a cold cache with
 *   50 concurrent readers issues 50 identical queries, and the cache makes the
 *   worst moment *worse* by adding work on top of the stampede it failed to
 *   prevent.
 *
 * Same caveat as the rate limiter: this is per-process. On serverless each
 * instance keeps its own copy, so the hit rate is lower than a shared cache
 * would give and an invalidation only reaches the instance that ran it. It is
 * still correct — entries expire on their own — just less effective. Moving to
 * a shared store is a change inside this module.
 *
 * Only cache things that are safe to share. `cacheKey` builds keys explicitly
 * for that reason; see the call sites in `lib/db/` for why each key contains
 * what it does.
 */

export interface CacheOptions {
  /** How long the value is served without any refetch. */
  ttlMs: number;
  /**
   * How long *after* `ttlMs` a stale value may still be served while it
   * refreshes behind the request. 0 disables SWR for this key.
   */
  staleMs?: number;
}

export interface CacheStats {
  hits: number;
  /** Served stale while refreshing behind the request. */
  staleHits: number;
  misses: number;
  /** Requests that joined an in-flight fetch instead of starting one. */
  coalesced: number;
  evictions: number;
  size: number;
}

interface Entry<T> {
  value: T;
  freshUntilMs: number;
  staleUntilMs: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;

export class ReadThroughCache {
  readonly #entries = new Map<string, Entry<unknown>>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #now: () => number;
  readonly #maxEntries: number;
  #stats = { hits: 0, staleHits: 0, misses: 0, coalesced: 0, evictions: 0 };

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions,
  ): Promise<T> {
    const now = this.#now();
    const entry = this.#entries.get(key) as Entry<T> | undefined;

    if (entry && now < entry.freshUntilMs) {
      this.#touch(key, entry);
      this.#stats.hits += 1;
      return entry.value;
    }

    if (entry && now < entry.staleUntilMs) {
      this.#touch(key, entry);
      this.#stats.staleHits += 1;
      // Deliberately not awaited: the caller gets the stale value now. A failed
      // refresh must not reject here or it would surface as an error on a
      // request we already answered successfully.
      void this.#fetchOnce(key, fetcher, options).catch(() => undefined);
      return entry.value;
    }

    return this.#fetchOnce(key, fetcher, options);
  }

  /** One fetch per key at a time; everyone else awaits the same promise. */
  async #fetchOnce<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions,
  ): Promise<T> {
    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.#stats.coalesced += 1;
      return existing;
    }

    this.#stats.misses += 1;

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.set(key, value, options);
        return value;
      } finally {
        // Cleared in `finally` so a rejected fetch doesn't wedge the key: the
        // next caller should get a fresh attempt, not a cached failure.
        this.#inFlight.delete(key);
      }
    })();

    this.#inFlight.set(key, promise);
    return promise;
  }

  set<T>(key: string, value: T, options: CacheOptions): void {
    const now = this.#now();
    const freshUntilMs = now + options.ttlMs;
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      freshUntilMs,
      staleUntilMs: freshUntilMs + (options.staleMs ?? 0),
    });
    this.#evictIfNeeded();
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Drop every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#inFlight.clear();
  }

  resetStats(): void {
    this.#stats = {
      hits: 0,
      staleHits: 0,
      misses: 0,
      coalesced: 0,
      evictions: 0,
    };
  }

  stats(): CacheStats {
    return { ...this.#stats, size: this.#entries.size };
  }

  /** Re-insert to move the key to the back of the LRU order. */
  #touch<T>(key: string, entry: Entry<T>): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry as Entry<unknown>);
  }

  #evictIfNeeded(): void {
    // Map iterates in insertion order and every read re-inserts, so the first
    // key is the least recently used.
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
      this.#stats.evictions += 1;
    }
  }
}

/**
 * Build a cache key from parts, with `null`/`undefined` collapsed to an empty
 * segment so "no search term" is one key rather than two.
 */
export function cacheKey(
  ...parts: (string | number | null | undefined)[]
): string {
  return parts
    .map((p) => (p === null || p === undefined ? "" : String(p)))
    .join(":");
}

/** The application's shared cache. */
export const appCache = new ReadThroughCache();

/**
 * Set `CACHE_DISABLED=1` for the control leg of the benchmark (Spec §9): the
 * same binary, the same script, one variable different.
 */
export function cachingEnabled(): boolean {
  return process.env.CACHE_DISABLED !== "1";
}
