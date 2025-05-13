import { CardSkeleton, HeadingSkeleton } from "@/components/ui/skeleton";

/**
 * The listings page makes two RPC round-trips (claims + browse, or the donor's
 * own listings), so it is the most likely page to be visibly waiting.
 */
export default function Loading() {
  return (
    <div className="grid gap-8">
      <HeadingSkeleton />
      <CardSkeleton lines={5} />
      <div className="grid gap-3">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
}
