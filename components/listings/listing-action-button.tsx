"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { ListingResult } from "@/app/app/listings/actions";
import { Button } from "@/components/ui/button";

/**
 * One button for the four id-only lifecycle actions (claim / release / complete
 * / cancel). The server decides whether the transition is allowed; this only
 * reports the answer.
 *
 * Note there is no optimistic update. Claiming is contended — two recipients
 * can press at the same moment and only one wins — so showing success before
 * the server has ruled would be showing a lie to whoever lost.
 */
export function ListingActionButton({
  listingId,
  action,
  label,
  pendingLabel,
  successMessage,
  variant = "default",
  size = "sm",
}: {
  listingId: string;
  action: (id: string) => Promise<ListingResult>;
  label: string;
  pendingLabel: string;
  successMessage: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await action(listingId);
          if (result.ok) {
            toast.success(successMessage);
            router.refresh();
          } else {
            toast.error(result.message);
            // Refresh on failure too: "someone else claimed that first" means
            // our view is stale, and the fix is to go and look again.
            router.refresh();
          }
        })
      }
    >
      {isPending ? pendingLabel : label}
    </Button>
  );
}
