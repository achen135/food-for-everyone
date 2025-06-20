import {
  CardSkeleton,
  HeadingSkeleton,
  Skeleton,
} from "@/components/ui/skeleton";

/**
 * The heaviest page in the app by round-trip count: five aggregate RPCs, four
 * of them in parallel behind the summary that gates them. The skeleton mirrors
 * the real layout — tiles then a chart — so the page does not jump when the
 * data lands.
 */
export default function Loading() {
  return (
    <div className="grid gap-10">
      <HeadingSkeleton />

      <div className="grid gap-6">
        <Skeleton className="h-5 w-44" />
        <CardSkeleton lines={3} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>

      <div className="grid gap-6">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
