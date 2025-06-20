"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/**
 * Live updates for the dashboard.
 *
 * One `postgres_changes` subscription on `public.listings`; any change
 * re-renders the Server Component, which re-runs the aggregate functions.
 * Realtime streams *rows*, not aggregates — there is no way to subscribe to
 * "the count changed" — so the row is only ever a signal to go and re-read.
 *
 * ## What this does and does not see, honestly
 *
 * Supabase decides who receives a row change by running the table's SELECT
 * policy against the subscriber, so this only fires for listings the caller can
 * already see: their own if they are a donor, plus open ones and anything they
 * hold a claim on if they are a recipient (M6 migration). The *network* panel
 * therefore updates live only when the change happens to be one the caller can
 * see; another donor's completion updates the numbers on the next page load,
 * not the instant it happens. Widening that would mean widening the SELECT
 * policy, which is exactly the disclosure M3 declined to make — a live number
 * is not worth publishing the directory for.
 *
 * ## Why it is debounced
 *
 * The seeded network produces bursts, and `router.refresh()` per row would
 * re-run five aggregates for each one. Coalescing to one refresh per quiet
 * moment keeps a burst to a single re-read; a second of latency on a chart is
 * imperceptible, whereas the refetch storm is not.
 */

const REFRESH_DEBOUNCE_MS = 700;

export function AnalyticsRealtime() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const scheduleRefresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const channel = supabase
      .channel("analytics-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "listings" },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
