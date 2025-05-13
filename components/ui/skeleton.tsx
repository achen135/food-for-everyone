import { cn } from "@/lib/utils";

/**
 * Loading placeholders for the `/app/*` route skeletons.
 *
 * `animate-pulse` is the only motion, and the global
 * `prefers-reduced-motion` rule in `globals.css` flattens it for anyone who
 * asks — so this stays a static block rather than a throbbing one.
 *
 * Marked `aria-hidden`: a screen reader should hear the route's own loading
 * announcement, not a description of grey rectangles.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bg-muted animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

/** A page title plus its supporting line. */
function HeadingSkeleton() {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-md" />
    </div>
  );
}

/** A bordered card with `lines` rows of placeholder text. */
function CardSkeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border grid gap-3 rounded-xl border p-6",
        className,
      )}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-4"
          // Ragged widths read as text; equal widths read as a table.
          style={{ width: `${100 - ((i * 17) % 45)}%` }}
        />
      ))}
    </div>
  );
}

export { CardSkeleton, HeadingSkeleton, Skeleton };
