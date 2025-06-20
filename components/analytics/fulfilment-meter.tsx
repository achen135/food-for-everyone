import type { Fulfilment } from "@/lib/analytics";

/**
 * Fulfilment rate: the share of an organization's *finished* work that ended
 * with food actually moving.
 *
 * Two decisions worth keeping:
 *
 *   **The fraction ships with the percentage.** "83%" has to be taken on trust;
 *   "83% — 20 of 24 listings that finished" can be checked, and a rate computed
 *   from four listings looks as thin as it is instead of impressively high.
 *
 *   **Nothing finished is not 0%.** A new organization with three open listings
 *   has failed at nothing. Rendering that as an empty red-adjacent bar would be
 *   a straightforward lie, so the meter is replaced by a sentence.
 *
 * The track is a lighter step of the fill's own ramp rather than a grey, so the
 * bar reads as one object at a glance.
 */
export function FulfilmentMeter({ fulfilment }: { fulfilment: Fulfilment }) {
  const { rate, detail } = fulfilment;

  if (rate === null) {
    return (
      <div className="grid gap-1">
        <p className="text-muted-foreground text-sm">Fulfilment rate</p>
        <p className="text-sm">
          {detail}. The rate appears once something has been collected,
          cancelled, or expired.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-muted-foreground text-sm">Fulfilment rate</p>
        <p className="text-2xl font-semibold">{rate.toFixed(1)}%</p>
      </div>
      <div
        role="meter"
        aria-valuenow={Math.round(rate)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Fulfilment rate"
        className="bg-chart-track h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-chart-completed h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, rate))}%` }}
        />
      </div>
      <p className="text-muted-foreground text-xs">{detail}</p>
    </div>
  );
}
