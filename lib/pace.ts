/**
 * Process-global outbound pacer (M9).
 *
 * This is **not** a rate limiter, and the difference is the whole reason it
 * exists. `TokenBucketLimiter` (lib/rate-limit.ts) answers "may *this caller*
 * do another one?" and rejects when the answer is no. This answers "may *this
 * process* put another request on the wire yet?" and, normally, waits until it
 * may.
 *
 * Nominatim's usage policy caps us at **1 request/second for the whole
 * application**, measured at our egress IP — not per user. A per-user bucket
 * cannot express that: thirty users each comfortably inside their own budget
 * still put thirty requests a second on the wire. So the two mechanisms are
 * stacked, and they are not interchangeable:
 *
 *   - the per-user bucket stops one account monopolising the shared budget;
 *   - this pacer keeps the *aggregate* inside the third party's ceiling.
 *
 * ## Why waiting, not rejecting
 *
 * A caller that arrives while the pace is booked waits for its slot. Rejecting
 * would be the wrong default here: the user asked us to look up a real address
 * and the only obstacle is our own politeness budget, so making them wait
 * 800 ms is honest where telling them we found nothing would not be. But the
 * wait is **bounded** — an unbounded queue turns a burst into a multi-minute
 * backlog of Server Actions, each holding a request open. Past
 * `maxQueueWaitMs` the pacer throws `OutboundPaceSaturatedError`, and the
 * caller is expected to surface that as "busy, try again", never as "no
 * results".
 *
 * ## The honest caveat
 *
 * Same shape as the rate limiter's and the cache's: this is per-process state.
 * On serverless, N warm instances pace independently, so the true egress rate
 * is up to N req/s and the policy holds only while N is 1. On Hobby-tier
 * traffic that is the normal case, but it is a property of the deployment, not
 * a guarantee of this code. Making it exact means moving the slot clock
 * somewhere shared, or routing outbound geocoding through a single worker —
 * a change inside this module, not at its call sites.
 */

/** Thrown when the projected wait for a slot exceeds `maxQueueWaitMs`. */
export class OutboundPaceSaturatedError extends Error {
  /** How long the caller would have had to wait, in ms. */
  readonly waitMs: number;

  constructor(waitMs: number) {
    super(`Outbound pace saturated — next slot is ${waitMs}ms away.`);
    this.name = "OutboundPaceSaturatedError";
    this.waitMs = waitMs;
  }
}

export interface OutboundPaceConfig {
  /** Minimum wall-clock gap between two outbound calls, in ms. */
  minIntervalMs: number;
  /** Longest a caller may be made to wait for a slot before being refused. */
  maxQueueWaitMs: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OutboundPacer {
  readonly #config: OutboundPaceConfig;
  readonly #now: () => number;
  readonly #wait: (ms: number) => Promise<void>;

  /** Earliest wall-clock time at which the next call may go out. */
  #nextSlotMs = 0;
  #queueDepth = 0;

  constructor(
    config: OutboundPaceConfig,
    options: { now?: () => number; wait?: (ms: number) => Promise<void> } = {},
  ) {
    if (config.minIntervalMs <= 0 || config.maxQueueWaitMs < 0) {
      throw new Error(
        "minIntervalMs must be positive and maxQueueWaitMs non-negative.",
      );
    }
    this.#config = config;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? sleep;
  }

  /**
   * Run `fn` no sooner than the next free slot, then book the one after it.
   *
   * The reservation — read `#nextSlotMs`, decide, write it back — contains no
   * `await`, so on JS's single thread it is atomic with respect to other
   * callers. That is what makes concurrent callers queue up one second apart
   * instead of all reading the same slot and firing together; if an `await`
   * ever creeps between the read and the write, this silently stops working
   * and the failure looks like an unexplained ban rather than a bug here.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const slotMs = Math.max(now, this.#nextSlotMs);
    const waitMs = slotMs - now;

    if (waitMs > this.#config.maxQueueWaitMs) {
      // Not booked: a refused caller must not push the queue further out, or a
      // client retrying through the refusal would never get in.
      throw new OutboundPaceSaturatedError(waitMs);
    }

    this.#nextSlotMs = slotMs + this.#config.minIntervalMs;
    this.#queueDepth += 1;

    try {
      if (waitMs > 0) await this.#wait(waitMs);
      return await fn();
    } finally {
      this.#queueDepth -= 1;
    }
  }

  /**
   * Callers currently holding or waiting on a slot. Observability only — do
   * not branch on it, since it changes under you between `await`s.
   */
  get queueDepth(): number {
    return this.#queueDepth;
  }

  /** The configured gap between outbound calls. Readable so a test can assert it. */
  get minIntervalMs(): number {
    return this.#config.minIntervalMs;
  }

  /** The configured ceiling on how long a caller may be queued. */
  get maxQueueWaitMs(): number {
    return this.#config.maxQueueWaitMs;
  }

  /** Test helper: forget the booked slot. */
  reset(): void {
    this.#nextSlotMs = 0;
  }
}

/**
 * The pacer guarding OpenStreetMap Nominatim (lib/geocode.ts).
 *
 * `minIntervalMs` is 1000 because the policy says 1 req/s, full stop — this
 * number is a third party's rule, not a tuning knob, and it does not move
 * without a different geocoder behind it.
 *
 * `maxQueueWaitMs` of 3000 means at most three callers queue ahead of you.
 * Combined with `geocodeAddress`'s 5 s fetch timeout, the worst honest wait a
 * user can see is ~8 s; past that a refusal is kinder than a spinner.
 *
 * Module scope on purpose: one slot clock shared by every request this process
 * handles. A per-request instance would pace nothing.
 */
export const nominatimPacer = new OutboundPacer({
  minIntervalMs: 1000,
  maxQueueWaitMs: 3000,
});
