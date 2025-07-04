/**
 * In-process token-bucket rate limiter (Spec §9, M7).
 *
 * A bucket holds up to `capacity` tokens and refills at `refillPerSecond`. Each
 * request spends one. That shape is chosen deliberately over a fixed window:
 *
 *   - A fixed window lets a client spend its whole quota in the last instant of
 *     one window and again in the first instant of the next — twice the
 *     intended rate across that boundary. A bucket has no boundary.
 *   - Capacity and refill rate are separate dials, so "60 requests a minute but
 *     a burst of 10 is fine" is expressible. A window can't say that.
 *
 * Refill is computed lazily on read rather than by a timer: there is no work,
 * and no wakeups, for a key nobody is using.
 *
 * ## The honest caveat
 *
 * This is per-process state. On Vercel each serverless instance gets its own
 * buckets, so the effective limit is roughly `limit × instances` and a client
 * whose requests land on different instances sees a looser cap than configured.
 * That is a deliberate trade for v1: it costs nothing, adds no dependency, and
 * still stops the case that matters here — one client hammering one endpoint in
 * a tight loop. Making it exact means moving the counter somewhere shared
 * (Upstash Redis is the free-tier option noted in Spec §9), which is a swap of
 * this module's internals, not of its callers.
 */

export interface RateLimitConfig {
  /** Maximum burst — tokens the bucket holds when full. */
  capacity: number;
  /** Sustained rate, in tokens per second. */
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Configured burst capacity, for the `RateLimit-Limit` header. */
  limit: number;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Milliseconds until the next token is available. 0 when allowed. */
  retryAfterMs: number;
  /** Milliseconds until the bucket is full again. */
  resetAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Hard ceiling on tracked keys, so a flood of unique keys can't grow memory without bound. */
const DEFAULT_MAX_KEYS = 10_000;

export class TokenBucketLimiter {
  readonly #config: RateLimitConfig;
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(
    config: RateLimitConfig,
    options: { now?: () => number; maxKeys?: number } = {},
  ) {
    if (config.capacity <= 0 || config.refillPerSecond <= 0) {
      throw new Error("Rate limit capacity and refill rate must be positive.");
    }
    this.#config = config;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Milliseconds for an empty bucket to refill completely. */
  get #fullRefillMs(): number {
    return (this.#config.capacity / this.#config.refillPerSecond) * 1000;
  }

  /**
   * Spend one token for `key`.
   *
   * Note the bucket is only mutated when the request is allowed — a rejected
   * request must not push the recovery time further out, or a client polling
   * through a 429 would never recover.
   */
  check(key: string): RateLimitDecision {
    const now = this.#now();
    const { capacity, refillPerSecond } = this.#config;

    const bucket = this.#buckets.get(key) ?? {
      tokens: capacity,
      lastRefillMs: now,
    };

    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const tokens = Math.min(
      capacity,
      bucket.tokens + (elapsedMs / 1000) * refillPerSecond,
    );

    const allowed = tokens >= 1;
    const remaining = allowed ? tokens - 1 : tokens;

    this.#buckets.delete(key);
    this.#buckets.set(key, { tokens: remaining, lastRefillMs: now });
    this.#evictIfNeeded(now);

    return {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(remaining)),
      retryAfterMs: allowed
        ? 0
        : Math.ceil(((1 - remaining) / refillPerSecond) * 1000),
      resetAfterMs: Math.ceil(
        ((capacity - remaining) / refillPerSecond) * 1000,
      ),
    };
  }

  /**
   * Drop buckets that have had long enough to refill completely: a full bucket
   * is indistinguishable from one that never existed, so forgetting it changes
   * no future decision. Only if that leaves us over the ceiling do we evict
   * live buckets, oldest-touched first — that *does* forgive some spend, which
   * is why it is the fallback rather than the strategy.
   */
  #evictIfNeeded(now: number): void {
    if (this.#buckets.size <= this.#maxKeys) return;

    const idleCutoff = now - this.#fullRefillMs;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastRefillMs <= idleCutoff) this.#buckets.delete(key);
    }

    // Map preserves insertion order, and `check` re-inserts on every touch, so
    // iteration order is least-recently-used first.
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= this.#maxKeys) break;
      this.#buckets.delete(key);
    }
  }

  /** Test/benchmark helper. */
  reset(): void {
    this.#buckets.clear();
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * Headers for a decision, using the `RateLimit-*` names from the IETF draft
 * plus `Retry-After` (RFC 9110), which is the one clients and CDNs actually act
 * on. Seconds, per spec — hence the rounding.
 */
export function rateLimitHeaders(
  decision: RateLimitDecision,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.ceil(decision.resetAfterMs / 1000)),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
    );
  }
  return headers;
}

/**
 * Limiter for the authenticated map query. 30 requests/minute sustained with a
 * burst of 30: the map refetches on radius change, on a debounced search, and
 * on "search this area", so a user moving around the map genuinely produces
 * bursts — the cap is there to stop a script, not to pace a person.
 *
 * Module scope on purpose: one bucket store shared by every request this
 * process handles.
 */
export const mapQueryLimiter = new TokenBucketLimiter({
  capacity: 30,
  refillPerSecond: 0.5,
});

/**
 * Limiter for the address-search Server Action (M9). Tighter than the map's,
 * because the two are shaped nothing alike: the map refetches on every pan and
 * radius change, while address search is a button a user presses a handful of
 * times while setting up their organization. A burst of 6 covers fixing a typo
 * and trying a couple of phrasings; 12/minute sustained is well past normal use
 * and well short of abuse.
 *
 * **This limiter does not enforce Nominatim's policy and must not be mistaken
 * for the thing that does.** Its budget is per user, and the policy is a single
 * application-wide ceiling on our egress IP — thirty users inside their own
 * budgets would blow through it. `nominatimPacer` (lib/pace.ts) is what
 * enforces the policy; this stops one account eating the shared budget before
 * anyone else can.
 *
 * Note also that this one lives in a Server Action rather than behind RLS,
 * which everywhere else in this codebase would be a mistake (CLAUDE.md: "a
 * guard in a Server Action is not a boundary"). It is acceptable *only* because
 * what it protects is a third party's rate budget, not our data: the worst a
 * caller who bypasses it can do is reach `nominatimPacer`, which is not
 * bypassable from outside the process. Do not copy this placement for anything
 * guarding a table.
 */
export const geocodeLimiter = new TokenBucketLimiter({
  capacity: 6,
  refillPerSecond: 0.2,
});

/** Set `RATE_LIMIT_DISABLED=1` for the read-count leg of the benchmark (Spec §9). */
export function rateLimitingEnabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED !== "1";
}
