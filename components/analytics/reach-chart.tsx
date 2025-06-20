"use client";

import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";

import { formatCount } from "@/lib/analytics";
import type { NetworkReachBand } from "@/lib/db/types";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartDataTable } from "@/components/analytics/chart-data-table";

/**
 * How far collected food travelled, as a histogram of donor→recipient distance.
 *
 * One series, so no legend — the heading says what is plotted. The bands are
 * *ordered*, so they take a single-hue ramp light→dark rather than five
 * categorical hues: the reader should see the ordering in the colour, and
 * spending five identity hues on one series would say these are five unrelated
 * things.
 *
 * Horizontal bars because the band names are words, not dates — vertical
 * columns would need rotated labels to fit "Under 5 km".
 */

/** The ordinal ramp, light→dark. Order matches `bucket_order` from SQL. */
const BAND_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const config = {
  donations: { label: "Donations" },
} satisfies ChartConfig;

export function ReachChart({ bands }: { bands: NetworkReachBand[] }) {
  const total = bands.reduce((sum, b) => sum + b.donations, 0);

  if (total === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No completed donations yet, so there is no distance to measure.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <ChartContainer config={config} className="aspect-[16/8] w-full">
        <BarChart
          accessibilityLayer
          layout="vertical"
          data={bands}
          margin={{ left: 0, right: 36, top: 4, bottom: 4 }}
        >
          <XAxis type="number" dataKey="donations" hide />
          <YAxis
            type="category"
            dataKey="bucket"
            width={92}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel={false} />}
          />
          {/*
           * `barSize` caps the mark rather than letting it fill its band — the
           * leftover is air, not a thicker bar. The radius rounds the data end
           * only; the baseline end stays square.
           */}
          <Bar dataKey="donations" barSize={20} radius={[0, 4, 4, 0]}>
            {bands.map((band, index) => (
              <Cell
                key={band.bucket}
                fill={BAND_COLORS[index % BAND_COLORS.length]}
              />
            ))}
            {/*
             * Value at the tip. Five bars is few enough that every one can carry
             * its number without becoming noise, and it means the chart reads
             * without the axis. Text wears a text token, never the bar's colour.
             */}
            <LabelList
              dataKey="donations"
              position="right"
              offset={8}
              className="fill-muted-foreground"
              fontSize={12}
              formatter={(value) => formatCount(Number(value ?? 0))}
            />
          </Bar>
        </BarChart>
      </ChartContainer>

      <ChartDataTable
        caption="Completed donations by distance between donor and recipient"
        columns={["Distance", "Donations"]}
        rows={bands.map((b) => [b.bucket, formatCount(b.donations)])}
      />
    </div>
  );
}
