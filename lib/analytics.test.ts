import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDay,
  fulfilment,
  lastDays,
  myActivitySeries,
  networkSeries,
  seriesLabels,
  seriesTotals,
  tickDays,
  type ActivityPoint,
} from "@/lib/analytics";
import type { MyActivityDay, MyActivitySummary } from "@/lib/db/types";

const EMPTY_SUMMARY: MyActivitySummary = {
  role: "donor",
  listings_posted: 0,
  listings_open: 0,
  listings_expired: 0,
  listings_claimed: 0,
  listings_completed: 0,
  listings_cancelled: 0,
  claims_made: 0,
  claims_active: 0,
  claims_completed: 0,
  claims_released: 0,
  fulfilment_numerator: 0,
  fulfilment_denominator: 0,
  fulfilment_rate: null,
};

function day(n: number): ActivityPoint {
  return {
    day: `2026-06-${String(n).padStart(2, "0")}`,
    posted: n,
    completed: 1,
  };
}

describe("myActivitySeries", () => {
  const rows: MyActivityDay[] = [
    {
      day: "2026-09-01",
      listings_posted: 4,
      listings_completed: 3,
      claims_made: 9,
      claims_completed: 7,
    },
  ];

  it("plots a donor's listings", () => {
    expect(myActivitySeries(rows, "donor")).toEqual([
      { day: "2026-09-01", posted: 4, completed: 3 },
    ]);
  });

  it("plots a recipient's claims, not their (empty) listings", () => {
    // The bug this guards: a recipient has no listings, so reading the listing
    // columns gives a flat zero line that looks like "no activity" rather than
    // like a mistake.
    expect(myActivitySeries(rows, "recipient")).toEqual([
      { day: "2026-09-01", posted: 9, completed: 7 },
    ]);
  });

  it("names the series for the side you are on", () => {
    expect(seriesLabels("donor")).toEqual({
      posted: "Posted",
      completed: "Completed",
    });
    expect(seriesLabels("recipient")).toEqual({
      posted: "Claimed",
      completed: "Collected",
    });
  });
});

describe("networkSeries", () => {
  it("passes the two network columns straight through", () => {
    expect(
      networkSeries([{ day: "2026-09-01", posted: 5, completed: 2 }]),
    ).toEqual([{ day: "2026-09-01", posted: 5, completed: 2 }]);
  });
});

describe("lastDays", () => {
  const points = Array.from({ length: 10 }, (_, i) => day(i + 1));

  it("takes the most recent window, not the oldest", () => {
    const window = lastDays(points, 3);
    expect(window).toHaveLength(3);
    expect(window[window.length - 1].day).toBe("2026-06-10");
  });

  it("returns everything when the window is longer than the series", () => {
    expect(lastDays(points, 90)).toHaveLength(10);
  });

  it("handles the degenerate cases", () => {
    expect(lastDays(points, 0)).toEqual([]);
    expect(lastDays([], 30)).toEqual([]);
  });
});

describe("seriesTotals", () => {
  it("sums both series over the visible window", () => {
    expect(seriesTotals([day(1), day(2), day(3)])).toEqual({
      posted: 6,
      completed: 3,
    });
  });

  it("is zero for an empty window", () => {
    expect(seriesTotals([])).toEqual({ posted: 0, completed: 0 });
  });
});

describe("fulfilment", () => {
  it("reports the fraction behind the percentage", () => {
    const result = fulfilment({
      ...EMPTY_SUMMARY,
      listings_completed: 20,
      fulfilment_numerator: 20,
      fulfilment_denominator: 24,
      fulfilment_rate: 83.3,
    });
    expect(result.rate).toBe(83.3);
    expect(result.detail).toBe("20 of 24 listings that finished");
  });

  it("says nothing has finished rather than claiming 0%", () => {
    // A new organization with three open listings has failed at nothing.
    // Rendering that as 0% would be a straightforward lie.
    const result = fulfilment({ ...EMPTY_SUMMARY, listings_open: 3 });
    expect(result.rate).toBeNull();
    expect(result.detail).toBe("No listings have finished yet");
  });

  it("counts claims, not listings, for a recipient", () => {
    const result = fulfilment({
      ...EMPTY_SUMMARY,
      role: "recipient",
      claims_completed: 29,
      claims_released: 8,
      fulfilment_numerator: 29,
      fulfilment_denominator: 37,
      fulfilment_rate: 78.4,
    });
    expect(result.detail).toBe("29 of 37 claims that finished");
  });
});

describe("formatting", () => {
  it("groups thousands", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(0)).toBe("0");
  });

  it("formats a bucket as a UTC date, not a local one", () => {
    // The buckets are UTC dates from SQL. Parsing "2026-09-03" as local time
    // would shift the label back a day for anyone west of Greenwich — that
    // off-by-one is the property under test, so assert the day number rather
    // than the month abbreviation, which ICU spells differently across Node
    // versions ("Sep" vs "Sept").
    expect(formatDay("2026-09-03")).toMatch(/^3 Sep/);
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });

  it("leaves an unparseable value alone rather than printing Invalid Date", () => {
    expect(formatDay("not-a-date")).toBe("not-a-date");
  });
});

describe("tickDays", () => {
  it("labels every point when there are few enough", () => {
    const points = [day(1), day(2), day(3)];
    expect(tickDays(points, 6)).toHaveLength(3);
  });

  it("thins a long series but always keeps the newest day", () => {
    const points = Array.from({ length: 90 }, (_, i) => ({
      ...day(1),
      day: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    const ticks = tickDays(points, 6);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks[ticks.length - 1]).toBe(points[points.length - 1].day);
  });
});
