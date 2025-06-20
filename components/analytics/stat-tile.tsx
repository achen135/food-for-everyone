import type { ReactNode } from "react";

import { formatCount } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/**
 * A number that does not need a chart.
 *
 * Most of this dashboard's metrics are single values — a count of donors, how
 * many listings are open right now. Plotting one number as one bar spends a
 * chart's worth of space and attention on something a tile says better.
 */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border grid content-start gap-1 rounded-xl border p-4",
        className,
      )}
    >
      <dt className="text-muted-foreground text-sm">{label}</dt>
      {/*
       * The hint lives *inside* the <dd>, not beside it. A <div> grouping
       * inside a <dl> may contain only <dt>/<dd>, so a sibling <p> is invalid —
       * caught by the axe check in app/a11y.test.tsx, not by eye.
       *
       * Proportional figures, not tabular: these are standalone display
       * numbers, and `tabular-nums` gives every digit a zero's width, which
       * reads loose at this size. Tabular is for columns that must line up —
       * the data tables under the charts.
       */}
      <dd className="grid gap-1">
        <span className="text-2xl font-semibold">
          {typeof value === "number" ? formatCount(value) : value}
        </span>
        {hint ? (
          <span className="text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** The one number a view leads with. Exactly one per page. */
export function HeroStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="grid gap-1">
        <span className="text-5xl leading-none font-semibold tracking-tight">
          {formatCount(value)}
        </span>
        {hint ? (
          <span className="text-muted-foreground text-sm">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
