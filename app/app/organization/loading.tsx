import { CardSkeleton, HeadingSkeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="grid gap-6">
      <HeadingSkeleton />
      <CardSkeleton lines={7} />
    </div>
  );
}
