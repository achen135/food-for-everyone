import { describe, expect, it } from "vitest";

import { planActivity, type ActivityPlan } from "./activity.ts";

/**
 * The seed generator is the foundation the whole M8 dashboard stands on, so
 * these tests assert the properties the charts and the demo account depend on —
 * not the exact rows, which slide with `now` by design.
 *
 * Several of them mirror a database constraint (the partial unique index on
 * active claims, the `pickup_end > pickup_start` check, the length checks on
 * `title` and `quantity`). Duplicating them here is deliberate: it turns "the
 * insert failed after 40 seconds of seeding" into a millisecond-long unit test
 * failure that names the property that broke.
 */

const DONORS = Array.from({ length: 16 }, (_, i) => `donor-${i}`);
const RECIPIENTS = Array.from({ length: 14 }, (_, i) => `recipient-${i}`);
const DEMO = "demo-org";

/** A fixed instant, so a test failure is never a Tuesday-only mystery. */
const NOW = new Date("2026-09-02T18:30:00.000Z");

function plan(overrides: Partial<Parameters<typeof planActivity>[0]> = {}) {
  let n = 0;
  return planActivity({
    donorIds: DONORS,
    recipientIds: RECIPIENTS,
    demoDonorId: DEMO,
    now: NOW,
    newId: () => `id-${n++}`,
    ...overrides,
  });
}

function listingsById(p: ActivityPlan) {
  return new Map(p.listings.map((l) => [l.id, l]));
}

describe("planActivity", () => {
  it("generates enough history to support the 200+ figure in Spec §9", () => {
    const p = plan();
    // A band, not an exact count: the 90-day window slides with `now`, so which
    // weekdays it covers — and therefore the total — moves by a few rows. The
    // number this actually produced on the recorded run is in docs/Sessions.md.
    expect(p.listings.length).toBeGreaterThan(200);
    expect(p.listings.length).toBeLessThan(340);
  });

  it("is deterministic for a given instant", () => {
    expect(plan()).toEqual(plan());
  });

  it("never creates rows dated in the future", () => {
    const p = plan();
    for (const listing of p.listings) {
      expect(Date.parse(listing.created_at)).toBeLessThanOrEqual(NOW.getTime());
    }
    for (const claim of p.claims) {
      expect(Date.parse(claim.created_at)).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("spreads listings across the whole window rather than bunching at one end", () => {
    const days = new Set(plan().listings.map((l) => l.created_at.slice(0, 10)));
    // Weekday weighting and the Poisson-ish draw leave some days empty; the
    // point is that this is a 90-day history and not a single spike.
    expect(days.size).toBeGreaterThan(60);
  });

  it("produces every terminal state plus live listings", () => {
    const p = plan();
    const counts = new Map<string, number>();
    for (const l of p.listings) {
      counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
    }
    expect(counts.get("completed")).toBeGreaterThan(100);
    expect(counts.get("cancelled")).toBeGreaterThan(5);
    expect(counts.get("claimed")).toBeGreaterThan(0);

    // Expiry is derived, not stored: an expired listing is an `open` one whose
    // pickup window has closed (M6 migration header).
    const expired = p.listings.filter(
      (l) => l.status === "open" && Date.parse(l.pickup_end) <= NOW.getTime(),
    );
    const live = p.listings.filter(
      (l) => l.status === "open" && Date.parse(l.pickup_end) > NOW.getTime(),
    );
    expect(expired.length).toBeGreaterThan(10);
    expect(live.length).toBeGreaterThan(5);
  });

  it("respects the listings table's check constraints", () => {
    for (const l of plan().listings) {
      expect(Date.parse(l.pickup_end)).toBeGreaterThan(
        Date.parse(l.pickup_start),
      );
      expect(Date.parse(l.pickup_start)).toBeGreaterThanOrEqual(
        Date.parse(l.created_at),
      );
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.title.length).toBeLessThanOrEqual(120);
      expect(l.quantity.length).toBeGreaterThan(0);
      expect(l.quantity.length).toBeLessThanOrEqual(80);
      expect(l.notes === null || l.notes.length <= 1000).toBe(true);
    }
  });

  it("never puts two active claims on one listing", () => {
    // The database enforces this with a partial unique index; violating it here
    // would fail the seed halfway through an insert.
    const active = new Map<string, number>();
    for (const c of plan().claims) {
      if (c.status !== "active") continue;
      active.set(c.listing_id, (active.get(c.listing_id) ?? 0) + 1);
    }
    for (const count of active.values()) expect(count).toBe(1);
  });

  it("keeps claims consistent with the listing they belong to", () => {
    const p = plan();
    const byId = listingsById(p);

    for (const claim of p.claims) {
      const listing = byId.get(claim.listing_id);
      expect(listing).toBeDefined();
      expect(Date.parse(claim.created_at)).toBeGreaterThanOrEqual(
        Date.parse(listing!.created_at),
      );
      expect(RECIPIENTS).toContain(claim.organization_id);

      // `released_at` is what separates a finished claim from a live one.
      if (claim.status === "active") {
        expect(claim.released_at).toBeNull();
      } else {
        expect(claim.released_at).not.toBeNull();
      }
    }

    // A claimed listing has exactly one active claim; a completed one has
    // exactly one completed claim. These are the two shapes the fulfilment
    // rate is computed from.
    for (const listing of p.listings) {
      const mine = p.claims.filter((c) => c.listing_id === listing.id);
      if (listing.status === "claimed") {
        expect(mine.filter((c) => c.status === "active")).toHaveLength(1);
      }
      if (listing.status === "completed") {
        expect(mine.filter((c) => c.status === "completed")).toHaveLength(1);
      }
    }
  });

  describe("the read-only demo organization", () => {
    it("owns history, so its dashboard is not a wall of zeros", () => {
      const demo = plan().listings.filter((l) => l.organization_id === DEMO);
      expect(demo.length).toBeGreaterThan(5);
      expect(
        demo.filter((l) => l.status === "completed").length,
      ).toBeGreaterThan(0);
    });

    it("owns nothing it could act on", () => {
      // This is the property the M8 handoff asked for, and it holds
      // structurally rather than by convention: `claim_listing` needs `open`,
      // `complete_listing` needs `claimed`, `cancel_listing` needs `open` or
      // `claimed`, and all three additionally refuse a demo caller. A listing
      // in a terminal state with a closed window is inert to every write path.
      const demo = plan().listings.filter((l) => l.organization_id === DEMO);
      expect(demo.length).toBeGreaterThan(0);

      for (const listing of demo) {
        expect(listing.status).not.toBe("claimed");
        expect(Date.parse(listing.pickup_end)).toBeLessThan(NOW.getTime());
      }
    });

    it("is left out entirely when it has not been created yet", () => {
      const p = plan({ demoDonorId: null });
      expect(p.listings.some((l) => l.organization_id === DEMO)).toBe(false);
      expect(p.listings.length).toBeGreaterThan(200);
    });
  });

  it("plans nothing when there is no organization to plan for", () => {
    expect(plan({ donorIds: [] })).toEqual({ listings: [], claims: [] });
    expect(plan({ recipientIds: [] })).toEqual({ listings: [], claims: [] });
  });
});
