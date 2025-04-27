"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { OrganizationType } from "@/lib/db";
import { createClient } from "@/lib/supabase/client";

/**
 * Live updates for the listings page.
 *
 * Subscribes to Postgres changes on `public.listings`. Supabase decides who
 * receives a row by running that table's SELECT policy against the subscriber —
 * so a donor is only sent their own listings, and a recipient only open ones
 * (plus anything they hold a claim on). The authorization work was already done
 * in the migration; there is nothing to filter here.
 *
 * On any relevant change we `router.refresh()`, which re-runs the Server
 * Component and re-reads through the enriched RPCs. Re-fetching rather than
 * patching a local cache from the payload keeps one source of truth — the
 * payload is only used to decide whether to say something.
 */
export function ListingsRealtime({ role }: { role: OrganizationType }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("listings-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "listings" },
        (payload) => {
          const next = payload.new as { status?: string } | null;

          if (role === "recipient" && payload.eventType === "INSERT") {
            toast("A new donation was just posted nearby.");
          }

          // `payload.old` carries only the primary key unless the table is set
          // to REPLICA IDENTITY FULL, so this reads the new row rather than
          // comparing against the previous one.
          if (
            role === "donor" &&
            payload.eventType === "UPDATE" &&
            next?.status === "claimed"
          ) {
            toast.success("One of your listings was just claimed.");
          }

          router.refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [role, router]);

  return null;
}
