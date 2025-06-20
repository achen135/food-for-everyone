import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActivityChart } from "@/components/analytics/activity-chart";
import { FulfilmentMeter } from "@/components/analytics/fulfilment-meter";
import { ReachChart } from "@/components/analytics/reach-chart";
import { HeroStat, StatTile } from "@/components/analytics/stat-tile";
import { NETWORK_LABELS, type ActivityPoint } from "@/lib/analytics";

/**
 * These assert what the *reader* gets, not what Recharts draws: the SVG is not
 * meaningfully queryable in jsdom, and asserting on it would test the library.
 * What matters here is the surrounding contract — the totals, the range
 * control, the empty states, and the data table that carries the numbers when
 * the marks cannot.
 */

function series(days: number, from = 1): ActivityPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    day: `2026-06-${String(((i + from) % 28) + 1).padStart(2, "0")}`,
    posted: 2,
    completed: 1,
  }));
}

describe("ActivityChart", () => {
  it("defaults to the 30-day window and totals only what is visible", async () => {
    render(<ActivityChart points={series(90)} labels={NETWORK_LABELS} />);

    // 30 days × 2 posted, 30 × 1 completed — not the full 90 days behind it.
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
  });

  it("re-totals when the range changes, without refetching", async () => {
    const user = userEvent.setup();
    render(<ActivityChart points={series(90)} labels={NETWORK_LABELS} />);

    await user.click(screen.getByRole("button", { name: "14d" }));
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "14d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "90d" }));
    expect(screen.getByText("180")).toBeInTheDocument();
  });

  it("names the series for the caller's side, in the totals and the legend", () => {
    render(
      <ActivityChart
        points={series(5)}
        labels={{ posted: "Claimed", completed: "Collected" }}
      />,
    );
    // Two or more occurrences: the summary line above the plot and the legend
    // below it. A legend is not optional with two series — identity must never
    // rest on colour alone.
    expect(screen.getAllByText("Claimed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Collected").length).toBeGreaterThanOrEqual(2);
  });

  it("offers the underlying numbers as a table", async () => {
    const user = userEvent.setup();
    render(<ActivityChart points={series(3)} labels={NETWORK_LABELS} />);

    await user.click(screen.getByText("Show the data"));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Posted" }),
    ).toBeInTheDocument();
  });

  it("says so when there is nothing to plot", () => {
    render(<ActivityChart points={[]} labels={NETWORK_LABELS} />);
    expect(screen.getByText(/No activity recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Time range" })).toBeNull();
  });
});

describe("ReachChart", () => {
  const bands = [
    { bucket: "Under 5 km", bucket_order: 1, donations: 21 },
    { bucket: "5–10 km", bucket_order: 2, donations: 37 },
    { bucket: "50 km+", bucket_order: 5, donations: 0 },
  ];

  it("keeps empty bands so the histogram does not change shape", async () => {
    const user = userEvent.setup();
    render(<ReachChart bands={bands} />);

    await user.click(screen.getByText("Show the data"));
    expect(screen.getByRole("cell", { name: "50 km+" })).toBeInTheDocument();
  });

  it("shows an empty state rather than five zero-length bars", () => {
    render(<ReachChart bands={bands.map((b) => ({ ...b, donations: 0 }))} />);
    expect(screen.getByText(/No completed donations yet/)).toBeInTheDocument();
  });
});

describe("FulfilmentMeter", () => {
  it("shows the percentage and the fraction it came from", () => {
    render(
      <FulfilmentMeter
        fulfilment={{
          rate: 83.3,
          numerator: 20,
          denominator: 24,
          detail: "20 of 24 listings that finished",
        }}
      />,
    );

    expect(screen.getByText("83.3%")).toBeInTheDocument();
    expect(
      screen.getByText("20 of 24 listings that finished"),
    ).toBeInTheDocument();

    const meter = screen.getByRole("meter", { name: "Fulfilment rate" });
    expect(meter).toHaveAttribute("aria-valuenow", "83");
  });

  it("does not render 0% when nothing has finished", () => {
    render(
      <FulfilmentMeter
        fulfilment={{
          rate: null,
          numerator: 0,
          denominator: 0,
          detail: "No listings have finished yet",
        }}
      />,
    );

    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(
      screen.getByText(/No listings have finished yet/),
    ).toBeInTheDocument();
  });
});

describe("stat figures", () => {
  it("groups thousands and keeps the hint attached", () => {
    render(
      <dl>
        <StatTile label="Completed all time" value={1284} hint="of 2,000" />
      </dl>,
    );
    expect(screen.getByText("1,284")).toBeInTheDocument();
    expect(screen.getByText("of 2,000")).toBeInTheDocument();
  });

  it("renders the hero figure", () => {
    render(
      <dl>
        <HeroStat label="Donations completed" value={166} hint="from 264" />
      </dl>,
    );
    expect(screen.getByText("166")).toBeInTheDocument();
  });
});
