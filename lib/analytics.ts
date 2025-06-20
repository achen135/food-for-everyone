import type {
  MyActivityDay,
  MyActivitySummary,
  NetworkActivityDay,
  OrganizationType,
} from "@/lib/db/types";

/**
 * Presentation helpers for the M8 dashboard.
 *
 * Everything here is pure and framework-free, which is the point: the shaping
 * decisions that are easy to get quietly wrong — which pair of columns a
 * recipient's chart plots, what a fulfilment rate means when nothing has
 * finished, where a 90-day series gets cut for a 30-day view — are unit-tested
 * rather than eyeballed in a browser.
 */

/** One point on the activity chart, whichever series it came from. */
export interface ActivityPoint {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  posted: number;
  completed: number;
}

/** What the two series are called, which depends on which side you are on. */
export interface SeriesLabels {
  posted: string;
  completed: string;
}

export const NETWORK_LABELS: SeriesLabels = {
  posted: "Posted",
  completed: "Completed",
};

const DONOR_LABELS: SeriesLabels = { posted: "Posted", completed: "Completed" };
const RECIPIENT_LABELS: SeriesLabels = {
  posted: "Claimed",
  completed: "Collected",
};

export function seriesLabels(role: OrganizationType): SeriesLabels {
  return role === "donor" ? DONOR_LABELS : RECIPIENT_LABELS;
}

export function networkSeries(rows: NetworkActivityDay[]): ActivityPoint[] {
  return rows.map((r) => ({
    day: r.day,
    posted: r.posted,
    completed: r.completed,
  }));
}

/**
 * Pick the half of `my_activity_daily` that belongs to the caller's side.
 *
 * The function returns all four columns because an organization can change its
 * type and would then legitimately have both; `role` decides which pair is
 * being asked about now. Getting this wrong is silent — a recipient would see a
 * flat zero line rather than an error — so it is a function with a test rather
 * than a ternary inside a component.
 */
export function myActivitySeries(
  rows: MyActivityDay[],
  role: OrganizationType,
): ActivityPoint[] {
  return rows.map((r) => ({
    day: r.day,
    posted: role === "donor" ? r.listings_posted : r.claims_made,
    completed: role === "donor" ? r.listings_completed : r.claims_completed,
  }));
}

/** The last `days` points. The server fetches 90 once; the range control slices. */
export function lastDays(
  points: ActivityPoint[],
  days: number,
): ActivityPoint[] {
  if (days <= 0) return [];
  return points.slice(Math.max(0, points.length - days));
}

export function seriesTotals(points: ActivityPoint[]): {
  posted: number;
  completed: number;
} {
  return points.reduce(
    (acc, p) => ({
      posted: acc.posted + p.posted,
      completed: acc.completed + p.completed,
    }),
    { posted: 0, completed: 0 },
  );
}

/**
 * A rate is only worth showing with the fraction it came from. "83%" asks to be
 * trusted; "83% — 166 of 200" can be checked, and makes a rate computed from
 * four finished listings look as thin as it is.
 */
export interface Fulfilment {
  /** Percentage, or null when nothing has finished. */
  rate: number | null;
  numerator: number;
  denominator: number;
  /** e.g. "154 of 250 listings that finished". */
  detail: string;
}

export function fulfilment(summary: MyActivitySummary): Fulfilment {
  const { fulfilment_numerator: n, fulfilment_denominator: d, role } = summary;
  const noun = role === "donor" ? "listings" : "claims";
  return {
    rate: summary.fulfilment_rate,
    numerator: n,
    denominator: d,
    detail:
      d === 0
        ? `No ${noun} have finished yet`
        : `${formatCount(n)} of ${formatCount(d)} ${noun} that finished`,
  };
}

/** Thousands-separated. Counts here stay small; this is about not shouting. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** `2026-09-03` → `3 Sep`. Parsed as UTC — the buckets are UTC dates. */
export function formatDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * Axis ticks for a daily series. Ninety labels do not fit, and Recharts'
 * automatic thinning drops whichever ones it likes, so pick them here: roughly
 * `max` evenly spaced, always including the newest day.
 */
export function tickDays(points: ActivityPoint[], max = 6): string[] {
  if (points.length <= max) return points.map((p) => p.day);
  const step = Math.ceil(points.length / max);
  const ticks: string[] = [];
  for (let i = points.length - 1; i >= 0; i -= step)
    ticks.unshift(points[i].day);
  return ticks;
}
