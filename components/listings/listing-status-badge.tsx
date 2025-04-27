import type { ListingStatus } from "@/lib/db";
import { effectiveStatus } from "@/lib/validation/listing";
import { Badge } from "@/components/ui/badge";

const LABELS: Record<ListingStatus | "expired", string> = {
  open: "Open",
  claimed: "Claimed",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

const VARIANTS: Record<
  ListingStatus | "expired",
  "default" | "secondary" | "outline"
> = {
  open: "default",
  claimed: "secondary",
  completed: "secondary",
  cancelled: "outline",
  expired: "outline",
};

/**
 * `expired` is not a stored status — it's `open` past its pickup window. The
 * badge is where that derivation becomes visible to the user.
 */
export function ListingStatusBadge({
  status,
  pickupEnd,
}: {
  status: ListingStatus;
  pickupEnd: string;
}) {
  const shown = effectiveStatus(status, pickupEnd);
  return (
    <Badge variant={VARIANTS[shown]} className="w-fit">
      {LABELS[shown]}
    </Badge>
  );
}
