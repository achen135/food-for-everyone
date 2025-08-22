import { TriangleAlertIcon } from "lucide-react";

import type { RiskTier } from "@/lib/db";
import { Badge } from "@/components/ui/badge";

/**
 * The one visual treatment for an ML-flagged listing (M14).
 *
 * ## Only `high` renders
 *
 * `medium` and `low` return null. A badge on most of a donor's listings is
 * wallpaper — it stops being read within a session, and the whole point of the
 * escalation is that it is rare enough to act on. At the committed thresholds
 * the `high` tier is the one tied to a stated operating point (recall 0.8353 at
 * a 0.0430 false-alarm rate, `ml/model/model_card.json`), so it is the only
 * tier with a claim behind it worth showing a user.
 *
 * ## What it says, and what it does not
 *
 * "Unlikely to be collected" — a statement about this listing's prospects, in
 * the donor's own terms. Not a probability, not a score, and not the word
 * "risk" on its own, which reads as a warning about the food rather than about
 * the match. The model is trained on simulated data
 * (`ml/docs/simulator.md`), so a number here would imply a precision the
 * subsystem's own model card explicitly disclaims.
 *
 * ## Colour, and the AA trap in it
 *
 * Amber rather than red: this is a nudge to act — extend the window, re-post
 * later, call a nearby recipient — not an error state. Spec §8's amber is
 * `--brand-amber` (#e8a33d), "used sparingly", which is exactly this.
 *
 * It carries the badge's **border and tint only, never its text.** `#e8a33d`
 * is 2.1:1 on white — `app/globals.css` already records this, which is why the
 * chart palette deepened it to #c08420 rather than using it directly. Amber
 * label text would fail AA at this size. The text is `--foreground`, the same
 * near-black as body copy, and the colour does the signalling around it. The
 * icon is `aria-hidden`, so the badge never depends on colour alone to carry
 * its meaning.
 */
export function ListingRiskBadge({ tier }: { tier: RiskTier | undefined }) {
  if (tier !== "high") return null;

  return (
    <Badge
      variant="outline"
      className="border-brand-amber/60 bg-brand-amber/10 text-foreground w-fit gap-1"
      title="Based on pickup window, location and this donor's history — a model estimate, not a certainty."
    >
      <TriangleAlertIcon aria-hidden className="size-3" />
      Unlikely to be collected
    </Badge>
  );
}
