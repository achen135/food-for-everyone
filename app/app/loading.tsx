import { CardSkeleton, HeadingSkeleton } from "@/components/ui/skeleton";

/**
 * Shown while the dashboard's server component awaits the profile and
 * organization reads. Next swaps this in automatically via the route's Suspense
 * boundary — the shell in `layout.tsx` (header, nav) stays put, so only the
 * part that is actually loading moves.
 */
export default function Loading() {
  return (
    <div className="grid gap-6">
      <HeadingSkeleton />
      <CardSkeleton lines={4} />
    </div>
  );
}
