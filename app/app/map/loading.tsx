import { HeadingSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="grid gap-6">
      <HeadingSkeleton />
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Skeleton className="h-8 min-w-56 flex-1" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
        </div>
        {/* Matches the map container's fixed height so nothing jumps. */}
        <Skeleton className="h-[32rem] rounded-xl" />
      </div>
    </div>
  );
}
