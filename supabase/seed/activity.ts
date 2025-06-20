/**
 * Seeded historical activity — listings and claims spread across ~90 days.
 *
 * M8's dashboard needed something to draw. Before this file the seed created 30
 * organizations and no activity at all, so every aggregate was zero and every
 * chart was an empty state pretending to work.
 *
 * Everything here is SEEDED DEMO DATA. It is never described as real traffic —
 * not in the README, not in the UI, not in an interview (Spec §9).
 *
 * ## What "deterministic" means here
 *
 * `planActivity` is a pure function over a seeded PRNG, so the *shape* of the
 * data — how many listings, on which days, in which states, with which titles —
 * is identical on every run and re-derivable from this repo. Two things are
 * deliberately not fixed:
 *
 *   - **Timestamps are relative to `now`.** The window slides, so the dashboard
 *     shows 90 days of activity whenever it is seeded, rather than a chart that
 *     drifts off the left edge a month after the seed ran.
 *   - **Row ids** come from an injected factory (`crypto.randomUUID` in
 *     production, a counter in tests) because ids only have to be unique.
 *
 * ## Why the demo organization is handled separately
 *
 * The public read-only demo account is a donor (see `demo-account.ts`). It gets
 * history so its dashboard shows real numbers rather than a wall of zeros, but
 * **only in terminal states, with pickup windows already closed**. That is not a
 * UI convention — it is structural. `claim_listing` requires `status = 'open'`,
 * `complete_listing` requires `'claimed'`, and `cancel_listing` requires
 * `'open'` or `'claimed'`, so a completed or cancelled listing is inert to every
 * write path in the schema. The `is_demo_account()` guard inside those same
 * functions is the second, independent reason nothing here is actionable.
 */

export type SeedListingStatus = "open" | "claimed" | "completed" | "cancelled";
export type SeedClaimStatus = "active" | "released" | "completed";

export interface PlannedListing {
  id: string;
  organization_id: string;
  title: string;
  quantity: string;
  pickup_start: string;
  pickup_end: string;
  notes: string | null;
  status: SeedListingStatus;
  created_at: string;
  updated_at: string;
}

export interface PlannedClaim {
  id: string;
  listing_id: string;
  organization_id: string;
  status: SeedClaimStatus;
  created_at: string;
  released_at: string | null;
}

export interface ActivityPlan {
  listings: PlannedListing[];
  claims: PlannedClaim[];
}

export interface PlanOptions {
  /** Seeded donor organization ids, in a stable order. */
  donorIds: string[];
  /** Seeded recipient organization ids, in a stable order. */
  recipientIds: string[];
  /** The read-only demo organization, or null if it isn't set up yet. */
  demoDonorId: string | null;
  /** Reference instant. Everything is generated strictly before this. */
  now: Date;
  /** Length of the history window. */
  days?: number;
  /** Injected so tests get stable ids; defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

const HISTORY_DAYS = 90;

/**
 * Mean listings per day before the weekday weighting below. Tuned so the plan
 * lands near 260 listings in total — see `docs/Sessions.md` for the exact count
 * the committed constants produce, and Spec §9 for why the résumé quotes the
 * number the repo actually generates rather than the other way round.
 */
const LISTINGS_PER_DAY = 2.9;

/** Sunday-first. Fridays clear the most stock; Sundays the least. */
const WEEKDAY_WEIGHT = [0.45, 1.0, 1.0, 1.0, 1.05, 1.35, 0.7];

/**
 * The most recent days are generated separately, with pickup windows that run
 * past `now`, so "active listings" is never zero on a freshly seeded database.
 *
 * They *replace* the historical draw for those days rather than adding to it.
 * An earlier version layered a fixed number of live listings on top and left a
 * visible spike at the right-hand edge of every chart — an artefact of how the
 * data was made, which is exactly the kind of thing that quietly discredits a
 * dashboard. Recent days run hotter than the baseline (a demo wants a populated
 * browse page) but by a multiplier, not a step change.
 */
const LIVE_DAYS = 3;
const LIVE_DAY_MULTIPLIER = 2.2;
/**
 * One live listing in four has already been claimed — assigned by position
 * rather than by a dice roll, because a roll can legitimately come up "none" on
 * a dozen draws and leave the dashboard's "claimed" tile at zero on a freshly
 * seeded database.
 */
const LIVE_CLAIMED_EVERY = 4;

/** Terminal-state history for the read-only demo organization. */
const DEMO_LISTINGS = 14;

/**
 * How a listing that has run its course ended up. `expired` is not a stored
 * status — it is an `open` listing whose pickup window closed (see the M6
 * migration header), which is exactly what a listing nobody claimed looks like.
 */
const OUTCOME_COMPLETED = 0.655;
const OUTCOME_CANCELLED = 0.775;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Posting hours, UTC. 13:00–23:00 UTC is roughly a Chicago working day, and
 *  staying inside one UTC date keeps a day's listings in one chart bucket. */
const FIRST_POST_HOUR_UTC = 13;
const LAST_POST_HOUR_UTC = 23;

const TITLES = [
  "Surplus bread and pastries",
  "Prepared meals — soup and sandwiches",
  "Mixed produce boxes",
  "Dairy nearing best-before",
  "Bagged salad and greens",
  "Rotisserie chickens",
  "Catering leftovers — sandwiches and fruit",
  "Overstock canned goods",
  "Frozen entrées",
  "Day-old bagels",
  "Bulk rice and dried beans",
  "Deli trays",
  "Seasonal fruit — apples and pears",
  "Eggs and yoghurt",
  "Pasta and sauce cases",
  "Sheet cakes and desserts",
  "Soup stock and broth",
  "Cereal and granola cases",
  "Tortillas and flatbread",
  "Root vegetables — potatoes and carrots",
  "Milk cases",
  "Cheese ends and offcuts",
  "Ready-made sandwiches",
  "Bakery overstock — muffins and scones",
  "Fresh herbs and aromatics",
];

const QUANTITIES = [
  "3 crates",
  "~40 lbs",
  "12 trays",
  "18 boxes",
  "~25 meals",
  "2 pallets",
  "60 loaves",
  "~15 kg",
  "8 catering trays",
  "20 bags",
  "~50 portions",
  "5 crates",
];

const NOTES = [
  "Loading dock at the rear — ring the bell.",
  "Please bring your own crates.",
  "Refrigerated — needs collecting the same day.",
  "Ask for the duty manager at the service entrance.",
  "Packed and labelled, ready to go.",
  "Street parking out front is fine for a short load.",
  null,
  null,
  null,
];

/**
 * mulberry32 — small, fast, and good enough for demo data. The point is
 * reproducibility, not statistical quality: the same seed always yields the same
 * plan, so the numbers in `docs/Sessions.md` can be re-derived by re-running.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRNG_SEED = 0x00d1_5ea5;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/**
 * Index into `count` items, front-loaded — a handful of organizations do most
 * of the trading and there is a long tail behind them, which is what real
 * networks look like and what makes a "top partners" number mean anything.
 */
function weightedIndex(rng: () => number, count: number): number {
  const r = rng() ** 1.7;
  return Math.min(count - 1, Math.floor(r * count));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  );
}

/**
 * Build the full activity plan. Pure: same inputs, same output, no I/O.
 */
export function planActivity(options: PlanOptions): ActivityPlan {
  const {
    donorIds,
    recipientIds,
    demoDonorId,
    now,
    days = HISTORY_DAYS,
    newId = () => crypto.randomUUID(),
  } = options;

  const listings: PlannedListing[] = [];
  const claims: PlannedClaim[] = [];

  if (donorIds.length === 0 || recipientIds.length === 0) {
    return { listings, claims };
  }

  const rng = mulberry32(PRNG_SEED);
  const nowMs = now.getTime();
  const today = startOfUtcDay(now);

  // ---------------------------------------------------------------- history

  // Oldest first, so the generated ids and the PRNG draws follow the timeline.
  // Stops short of the last few days, which the live pass below covers.
  for (let offset = days - 1; offset >= LIVE_DAYS; offset -= 1) {
    const dayStart = today - offset * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    const lambda = LISTINGS_PER_DAY * WEEKDAY_WEIGHT[weekday];

    const hourSpan = LAST_POST_HOUR_UTC - FIRST_POST_HOUR_UTC;
    const count = Math.floor(lambda + rng());

    for (let i = 0; i < count; i += 1) {
      const createdMs =
        dayStart +
        (FIRST_POST_HOUR_UTC + rng() * hourSpan) * HOUR_MS +
        Math.floor(rng() * 60) * 60_000;
      // These days are all fully in the past, but never post into the future
      // regardless: a row dated after `now` would show up as a phantom bar on
      // the right-hand edge of every chart.
      if (createdMs >= nowMs) continue;

      // Pickup opens an hour or so later and runs for part of a shift.
      const pickupStartMs = createdMs + (1 + rng() * 5) * HOUR_MS;
      const pickupEndMs = pickupStartMs + (2 + rng() * 6) * HOUR_MS;

      const donorId = donorIds[weightedIndex(rng, donorIds.length)];
      const isLive = pickupEndMs > nowMs;

      // A window that hasn't closed yet is still in play; everything else has
      // reached one of the three ways a listing ends.
      const roll = rng();
      let status: SeedListingStatus;
      let expired = false;
      if (isLive) {
        status = roll < 0.7 ? "open" : "claimed";
      } else if (roll < OUTCOME_COMPLETED) {
        status = "completed";
      } else if (roll < OUTCOME_CANCELLED) {
        status = "cancelled";
      } else {
        // Nobody came for it. Stays `open`; the closed window is what makes it
        // expired, and every query derives that rather than storing it.
        status = "open";
        expired = true;
      }

      const listing = buildListing({
        rng,
        newId,
        organizationId: donorId,
        createdMs,
        pickupStartMs,
        pickupEndMs,
        status,
      });
      listings.push(listing);
      claims.push(
        ...claimsForListing({
          rng,
          newId,
          listing,
          expired,
          recipientIds,
          nowMs,
        }),
      );
    }
  }

  // -------------------------------------------------------------- live days
  //
  // The last couple of days, with pickup windows that have not closed yet.
  // Generated as their own pass because the historical loop only yields a live
  // listing when a window happens to straddle `now` — a handful on a good day
  // and none on a bad one. "Active listings" is a headline tile and a
  // recipient's browse page is the M6 demo; neither should depend on luck.

  let liveIndex = 0;
  for (let offset = LIVE_DAYS - 1; offset >= 0; offset -= 1) {
    const dayStart = today - offset * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    const lambda =
      LISTINGS_PER_DAY * WEEKDAY_WEIGHT[weekday] * LIVE_DAY_MULTIPLIER;

    // Today is only partly over — scale the draw to the hours that have
    // actually happened rather than posting a full day's worth by lunchtime.
    const latestHour =
      offset === 0
        ? Math.min(LAST_POST_HOUR_UTC, now.getUTCHours())
        : LAST_POST_HOUR_UTC;
    if (latestHour <= FIRST_POST_HOUR_UTC) continue;

    const hourSpan = latestHour - FIRST_POST_HOUR_UTC;
    const dayScale = hourSpan / (LAST_POST_HOUR_UTC - FIRST_POST_HOUR_UTC);
    const count = Math.floor(lambda * dayScale + rng());

    for (let i = 0; i < count; i += 1) {
      const createdMs =
        dayStart + (FIRST_POST_HOUR_UTC + rng() * hourSpan) * HOUR_MS;
      if (createdMs >= nowMs) continue;

      // Long enough windows that these are still collectable — surplus posted
      // today for pickup over the next day or two.
      const pickupStartMs = Math.max(
        createdMs + HOUR_MS,
        nowMs + rng() * 10 * HOUR_MS,
      );
      const pickupEndMs = pickupStartMs + (6 + rng() * 60) * HOUR_MS;

      const donorId = donorIds[weightedIndex(rng, donorIds.length)];
      const status: SeedListingStatus =
        liveIndex++ % LIVE_CLAIMED_EVERY === 1 ? "claimed" : "open";

      const listing = buildListing({
        rng,
        newId,
        organizationId: donorId,
        createdMs,
        pickupStartMs,
        pickupEndMs,
        status,
      });
      listings.push(listing);
      claims.push(
        ...claimsForListing({
          rng,
          newId,
          listing,
          expired: false,
          recipientIds,
          nowMs,
        }),
      );
    }
  }

  // ------------------------------------------------------------------ demo
  //
  // Terminal states only, windows already closed. See the module header for why
  // that is a structural guarantee and not a convention.

  if (demoDonorId) {
    for (let i = 0; i < DEMO_LISTINGS; i += 1) {
      const ageDays = 7 + rng() * 80;
      const createdMs = nowMs - ageDays * DAY_MS;
      const pickupStartMs = createdMs + (1 + rng() * 5) * HOUR_MS;
      const pickupEndMs = pickupStartMs + (2 + rng() * 6) * HOUR_MS;

      const roll = rng();
      const status: SeedListingStatus =
        roll < 0.72 ? "completed" : roll < 0.86 ? "cancelled" : "open";
      const expired = status === "open";

      const listing = buildListing({
        rng,
        newId,
        organizationId: demoDonorId,
        createdMs,
        pickupStartMs,
        pickupEndMs,
        status,
      });
      listings.push(listing);
      claims.push(
        ...claimsForListing({
          rng,
          newId,
          listing,
          expired,
          recipientIds,
          nowMs,
        }),
      );
    }
  }

  return { listings, claims };
}

function buildListing(args: {
  rng: () => number;
  newId: () => string;
  organizationId: string;
  createdMs: number;
  pickupStartMs: number;
  pickupEndMs: number;
  status: SeedListingStatus;
}): PlannedListing {
  const {
    rng,
    newId,
    organizationId,
    createdMs,
    pickupStartMs,
    pickupEndMs,
    status,
  } = args;

  // `updated_at` marks the last transition, which is what the trigger would
  // have left behind had these rows been written a day at a time.
  const updatedMs =
    status === "completed"
      ? pickupEndMs
      : status === "cancelled"
        ? pickupStartMs
        : createdMs;

  return {
    id: newId(),
    organization_id: organizationId,
    title: pick(rng, TITLES),
    quantity: pick(rng, QUANTITIES),
    pickup_start: iso(pickupStartMs),
    pickup_end: iso(pickupEndMs),
    notes: pick(rng, NOTES),
    status,
    created_at: iso(createdMs),
    updated_at: iso(updatedMs),
  };
}

/**
 * The claim history a listing in this state would have accumulated.
 *
 * Claims are kept after release rather than deleted (M6 migration), so the
 * fulfilment rate can tell "collected" from "backed out" — the two outcomes
 * that look identical if you only store the listing's final status.
 */
function claimsForListing(args: {
  rng: () => number;
  newId: () => string;
  listing: PlannedListing;
  expired: boolean;
  recipientIds: string[];
  nowMs: number;
}): PlannedClaim[] {
  const { rng, newId, listing, expired, recipientIds, nowMs } = args;
  const created = Date.parse(listing.created_at);
  const pickupStart = Date.parse(listing.pickup_start);
  const pickupEnd = Date.parse(listing.pickup_end);
  const out: PlannedClaim[] = [];

  const claimant = () => recipientIds[weightedIndex(rng, recipientIds.length)];
  /** Somewhere between the listing appearing and its window opening. */
  const claimedAt = () =>
    created + rng() * Math.max(HOUR_MS, pickupStart - created);

  const withdrawn = (whenMs: number) => ({
    id: newId(),
    listing_id: listing.id,
    organization_id: claimant(),
    status: "released" as const,
    created_at: iso(Math.min(whenMs, nowMs)),
    released_at: iso(Math.min(whenMs + rng() * 6 * HOUR_MS, nowMs)),
  });

  if (listing.status === "completed") {
    // A fifth of completed pickups had someone back out first — realistic, and
    // it keeps `released` from being a rounding error in the fulfilment split.
    if (rng() < 0.18) out.push(withdrawn(claimedAt()));
    const at = claimedAt();
    out.push({
      id: newId(),
      listing_id: listing.id,
      organization_id: claimant(),
      status: "completed",
      created_at: iso(at),
      // `complete_listing` stamps `released_at` when the donor closes it out,
      // which in practice is around the end of the pickup window.
      released_at: iso(Math.min(pickupEnd, nowMs)),
    });
    return out;
  }

  if (listing.status === "claimed") {
    out.push({
      id: newId(),
      listing_id: listing.id,
      organization_id: claimant(),
      status: "active",
      created_at: iso(Math.min(claimedAt(), nowMs)),
      released_at: null,
    });
    return out;
  }

  if (listing.status === "cancelled") {
    // The donor pulled it while someone was holding it — `cancel_listing`
    // releases the claim on the way through.
    if (rng() < 0.4) out.push(withdrawn(claimedAt()));
    return out;
  }

  // Still `open`: either expired unclaimed, or live. Either way a recipient may
  // have claimed and then released it, putting it back on offer.
  if (rng() < (expired ? 0.15 : 0.2)) out.push(withdrawn(claimedAt()));
  return out;
}
