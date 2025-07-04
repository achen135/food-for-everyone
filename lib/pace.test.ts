import { describe, expect, it, vi } from "vitest";

import {
  OutboundPaceSaturatedError,
  OutboundPacer,
  nominatimPacer,
} from "@/lib/pace";

/**
 * A virtual clock.
 *
 * The important property: `wait` does **not** move the clock when it is
 * *called*, only when the waiter is *woken* — because that is what
 * `setTimeout` does. An earlier version of this double advanced time at call
 * time, which made concurrent callers observe a clock that had already jumped
 * forward and produced failures that looked like pacer bugs but were not.
 * Wake-ups fire in target-time order, driven off the microtask queue so the
 * tests never sleep for real.
 */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  const pending: { at: number; resolve: () => void }[] = [];
  let draining = false;

  function drain() {
    if (draining) return;
    draining = true;
    queueMicrotask(function step() {
      if (pending.length === 0) {
        draining = false;
        return;
      }
      pending.sort((a, b) => a.at - b.at);
      const next = pending.shift()!;
      nowMs = Math.max(nowMs, next.at);
      next.resolve();
      queueMicrotask(step);
    });
  }

  return {
    now: () => nowMs,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: nowMs + ms, resolve });
        drain();
      }),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function pacer(
  clock: ReturnType<typeof fakeClock>,
  minIntervalMs = 1000,
  maxQueueWaitMs = 3000,
) {
  return new OutboundPacer(
    { minIntervalMs, maxQueueWaitMs },
    { now: clock.now, wait: clock.wait },
  );
}

describe("OutboundPacer", () => {
  it("runs the first call with no wait", async () => {
    const clock = fakeClock();
    const p = pacer(clock);
    const started = clock.now();

    await expect(p.run(async () => "ok")).resolves.toBe("ok");
    expect(clock.now()).toBe(started);
  });

  it("spaces sequential calls by minIntervalMs", async () => {
    const clock = fakeClock();
    const p = pacer(clock);
    const at: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      await p.run(async () => {
        at.push(clock.now());
      });
    }

    expect(at[1] - at[0]).toBe(1000);
    expect(at[2] - at[1]).toBe(1000);
  });

  it("books distinct slots for concurrent callers", async () => {
    const clock = fakeClock();
    const p = pacer(clock);
    const at: number[] = [];

    // Fired without awaiting in between — the reservation is synchronous, so
    // each caller must come away with its own slot rather than all three
    // reading the same one.
    await Promise.all(
      [0, 1, 2].map(() =>
        p.run(async () => {
          at.push(clock.now());
        }),
      ),
    );

    expect(new Set(at).size).toBe(3);
  });

  it("does not delay a call that arrives after the interval has passed", async () => {
    const clock = fakeClock();
    const p = pacer(clock);

    await p.run(async () => undefined);
    clock.advance(5000);

    const before = clock.now();
    await p.run(async () => undefined);
    expect(clock.now()).toBe(before);
  });

  it("throws OutboundPaceSaturatedError past maxQueueWaitMs", async () => {
    const clock = fakeClock();
    const p = pacer(clock, 1000, 2500);

    // Slots 0..2 are free or within the 2500ms wait budget; the fourth is 3000ms out.
    const inFlight = [0, 1, 2, 3].map(() => p.run(async () => undefined));
    const settled = await Promise.allSettled(inFlight);

    expect(settled.slice(0, 3).every((s) => s.status === "fulfilled")).toBe(
      true,
    );
    expect(settled[3].status).toBe("rejected");
    const reason = (settled[3] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(OutboundPaceSaturatedError);
    expect(reason.waitMs).toBe(3000);
  });

  it("a refused caller does not push the queue further out", async () => {
    const clock = fakeClock();
    const p = pacer(clock, 1000, 0);

    await p.run(async () => undefined); // books up to now+1000
    await expect(p.run(async () => undefined)).rejects.toBeInstanceOf(
      OutboundPaceSaturatedError,
    );

    // The refusal must not have consumed a slot: after the interval elapses the
    // next caller goes straight through.
    clock.advance(1000);
    await expect(p.run(async () => "ok")).resolves.toBe("ok");
  });

  it("consumes the slot even when the call fails", async () => {
    const clock = fakeClock();
    const p = pacer(clock);

    await expect(
      p.run(async () => {
        throw new Error("nominatim down");
      }),
    ).rejects.toThrow("nominatim down");

    // A failed request still went out, so it still costs pace.
    const before = clock.now();
    await p.run(async () => undefined);
    expect(clock.now() - before).toBe(1000);
  });

  it("releases queue depth on both success and failure", async () => {
    const clock = fakeClock();
    const p = pacer(clock);

    await p.run(async () => undefined);
    await p.run(async () => Promise.reject(new Error("x"))).catch(() => {});

    expect(p.queueDepth).toBe(0);
  });

  it("rejects a non-positive interval", () => {
    expect(
      () => new OutboundPacer({ minIntervalMs: 0, maxQueueWaitMs: 100 }),
    ).toThrow();
  });

  it("does not call fn when saturated", async () => {
    const clock = fakeClock();
    const p = pacer(clock, 1000, 0);
    const fn = vi.fn(async () => undefined);

    await p.run(fn);
    await expect(p.run(fn)).rejects.toBeInstanceOf(OutboundPaceSaturatedError);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("nominatimPacer", () => {
  it("paces at Nominatim's documented 1 req/s ceiling", () => {
    // 1000ms is a third party's published rule, not a tuning knob. Asserting it
    // means a change has to be deliberate enough to update a test.
    expect(nominatimPacer.minIntervalMs).toBe(1000);
  });

  it("bounds the queue so a caller cannot be parked indefinitely", () => {
    expect(nominatimPacer.maxQueueWaitMs).toBeGreaterThan(0);
    expect(nominatimPacer.maxQueueWaitMs).toBeLessThanOrEqual(5000);
  });
});
