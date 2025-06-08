import { describe, expect, it } from "vitest";

import {
  TokenBucketLimiter,
  rateLimitHeaders,
  type RateLimitDecision,
} from "@/lib/rate-limit";

/** Controllable clock — the limiter is all about time, so real time can't test it. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function makeLimiter(
  capacity = 5,
  refillPerSecond = 1,
  clock = fakeClock(),
  maxKeys?: number,
) {
  return {
    clock,
    limiter: new TokenBucketLimiter(
      { capacity, refillPerSecond },
      { now: clock.now, maxKeys },
    ),
  };
}

describe("TokenBucketLimiter", () => {
  it("allows a full burst up to capacity, then refuses", () => {
    const { limiter } = makeLimiter(5, 1);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check("u1").allowed, `request ${i + 1}`).toBe(true);
    }
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("counts remaining down to zero", () => {
    const { limiter } = makeLimiter(3, 1);
    expect(limiter.check("u1").remaining).toBe(2);
    expect(limiter.check("u1").remaining).toBe(1);
    expect(limiter.check("u1").remaining).toBe(0);
    expect(limiter.check("u1").remaining).toBe(0);
  });

  it("refills at the configured rate, not all at once", () => {
    const { limiter, clock } = makeLimiter(5, 1);
    for (let i = 0; i < 5; i += 1) limiter.check("u1");
    expect(limiter.check("u1").allowed).toBe(false);

    clock.advance(1000); // one token
    expect(limiter.check("u1").allowed).toBe(true);
    expect(limiter.check("u1").allowed).toBe(false);

    clock.advance(2000); // two more
    expect(limiter.check("u1").allowed).toBe(true);
    expect(limiter.check("u1").allowed).toBe(true);
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("never refills past capacity, however long it idles", () => {
    const { limiter, clock } = makeLimiter(5, 1);
    for (let i = 0; i < 5; i += 1) limiter.check("u1");

    clock.advance(60 * 60 * 1000); // an hour

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check("u1").allowed, `request ${i + 1}`).toBe(true);
    }
    // Capacity is a ceiling: an idle hour must not bank an hour of tokens.
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("keeps separate budgets per key", () => {
    const { limiter } = makeLimiter(2, 1);
    expect(limiter.check("alice").allowed).toBe(true);
    expect(limiter.check("alice").allowed).toBe(true);
    expect(limiter.check("alice").allowed).toBe(false);

    expect(limiter.check("bob").allowed).toBe(true);
    expect(limiter.check("bob").allowed).toBe(true);
  });

  it("does not push recovery further out when a request is refused", () => {
    // A client polling through its 429s must still recover on schedule —
    // otherwise a retry loop keeps itself locked out forever.
    const { limiter, clock } = makeLimiter(1, 1);
    expect(limiter.check("u1").allowed).toBe(true);

    for (let i = 0; i < 20; i += 1) {
      clock.advance(10);
      expect(limiter.check("u1").allowed).toBe(false);
    }

    clock.advance(1000);
    expect(limiter.check("u1").allowed).toBe(true);
  });

  it("reports a retryAfter that is actually long enough to wait", () => {
    const { limiter, clock } = makeLimiter(2, 0.5); // one token per 2s
    limiter.check("u1");
    limiter.check("u1");
    const refused = limiter.check("u1");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);

    // Just before the advertised time, still refused; at it, allowed.
    clock.advance(refused.retryAfterMs - 1);
    expect(limiter.check("u1").allowed).toBe(false);
    clock.advance(1);
    expect(limiter.check("u1").allowed).toBe(true);
  });

  it("treats a clock that goes backwards as no elapsed time", () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 2, refillPerSecond: 1 },
      { now: clock.now },
    );
    limiter.check("u1");
    limiter.check("u1");
    clock.advance(-5000);
    // Must not credit tokens for negative elapsed time.
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("forgets idle keys instead of growing without bound", () => {
    const { limiter, clock } = makeLimiter(2, 1, fakeClock(), 10);
    for (let i = 0; i < 10; i += 1) limiter.check(`user-${i}`);
    expect(limiter.size).toBe(10);

    // Long enough for every existing bucket to have refilled completely, so
    // dropping them is indistinguishable from keeping them.
    clock.advance(10_000);
    for (let i = 10; i < 20; i += 1) limiter.check(`user-${i}`);

    expect(limiter.size).toBeLessThanOrEqual(11);
  });

  it("still enforces the limit for an active key while others are evicted", () => {
    const { limiter } = makeLimiter(2, 1, fakeClock(), 5);
    limiter.check("hot");
    limiter.check("hot");
    for (let i = 0; i < 50; i += 1) limiter.check(`cold-${i}`);
    // "hot" was touched most recently among the first entries, but even under
    // pressure the limiter must not hand it a fresh budget for free.
    expect(limiter.size).toBeLessThanOrEqual(6);
  });

  it("rejects nonsensical configuration rather than misbehaving later", () => {
    expect(
      () => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }),
    ).toThrow();
    expect(
      () => new TokenBucketLimiter({ capacity: 5, refillPerSecond: 0 }),
    ).toThrow();
  });
});

describe("rateLimitHeaders", () => {
  const allowed: RateLimitDecision = {
    allowed: true,
    limit: 30,
    remaining: 12,
    retryAfterMs: 0,
    resetAfterMs: 36_000,
  };

  it("advertises limit, remaining and reset on success", () => {
    expect(rateLimitHeaders(allowed)).toEqual({
      "RateLimit-Limit": "30",
      "RateLimit-Remaining": "12",
      "RateLimit-Reset": "36",
    });
  });

  it("omits Retry-After when the request was allowed", () => {
    expect(rateLimitHeaders(allowed)["Retry-After"]).toBeUndefined();
  });

  it("adds Retry-After, rounded up and never below 1s, when refused", () => {
    const headers = rateLimitHeaders({
      ...allowed,
      allowed: false,
      remaining: 0,
      retryAfterMs: 250,
    });
    // Rounding 0.25s down to "0" would invite an immediate retry.
    expect(headers["Retry-After"]).toBe("1");
  });
});
