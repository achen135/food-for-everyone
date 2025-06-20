"use client";

import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";

import {
  formatCount,
  formatDay,
  lastDays,
  seriesTotals,
  tickDays,
  type ActivityPoint,
  type SeriesLabels,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartDataTable } from "@/components/analytics/chart-data-table";

/**
 * Posted vs completed per day.
 *
 * Two marks of different *kinds*, not just different colours: completed is a
 * filled area, posted is a line above it. The gap between them is the part of
 * what was offered that nobody collected — the one thing this chart exists to
 * show — and the fill/stroke difference means the two series are still
 * distinguishable without relying on hue alone.
 *
 * The whole 90 days arrive once from the server and the range control slices
 * them here. Re-fetching per range would cost a round trip and, on this
 * codebase, a second `getUser()` with it (see the M7 benchmark) to redraw data
 * the browser already has.
 */

const RANGES = [
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const;

export function ActivityChart({
  points,
  labels,
  defaultDays = 30,
  className,
}: {
  points: ActivityPoint[];
  labels: SeriesLabels;
  defaultDays?: number;
  className?: string;
}) {
  const [days, setDays] = useState<number>(defaultDays);
  const visible = lastDays(points, days);
  const totals = seriesTotals(visible);

  const config = {
    posted: { label: labels.posted, color: "var(--chart-posted)" },
    completed: { label: labels.completed, color: "var(--chart-completed)" },
  } satisfies ChartConfig;

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No activity recorded yet. This chart fills in as listings are posted and
        collected.
      </p>
    );
  }

  return (
    <div className={cn("grid gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
         * The selective direct labelling. Ninety points cannot each carry a
         * number, so the two totals for the visible window sit here instead and
         * the tooltip carries the per-day detail.
         */}
        <dl className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt>{labels.posted}</dt>
            <dd className="text-foreground font-medium">
              {formatCount(totals.posted)}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>{labels.completed}</dt>
            <dd className="text-foreground font-medium">
              {formatCount(totals.completed)}
            </dd>
          </div>
        </dl>

        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Time range"
        >
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              aria-pressed={days === range.days}
              className={cn(
                "focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                days === range.days
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <ChartContainer config={config} className="aspect-[16/7] w-full">
        <ComposedChart
          accessibilityLayer
          data={visible}
          margin={{ left: 4, right: 8, top: 8, bottom: 0 }}
        >
          {/* Hairline, solid, horizontal only — recessive by design. */}
          <CartesianGrid
            vertical={false}
            stroke="var(--chart-grid)"
            strokeWidth={1}
          />
          <XAxis
            dataKey="day"
            ticks={tickDays(visible)}
            tickFormatter={formatDay}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={0}
          />
          <YAxis
            allowDecimals={false}
            width={28}
            tickLine={false}
            axisLine={false}
            tickMargin={4}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(v) => formatDay(String(v))}
              />
            }
          />
          <Area
            dataKey="completed"
            type="monotone"
            stroke="var(--color-completed)"
            strokeWidth={2}
            fill="var(--color-completed)"
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
          <Line
            dataKey="posted"
            type="monotone"
            stroke="var(--color-posted)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
          <ChartLegend content={<ChartLegendContent />} />
        </ComposedChart>
      </ChartContainer>

      <ChartDataTable
        caption={`${labels.posted} and ${labels.completed} per day, UTC`}
        columns={["Day", labels.posted, labels.completed]}
        rows={visible.map((p) => [
          formatDay(p.day),
          formatCount(p.posted),
          formatCount(p.completed),
        ])}
      />
    </div>
  );
}
