"use client";

import dynamic from "next/dynamic";

import type { LatLng } from "@/lib/db";

/**
 * Client-only boundary for the map.
 *
 * `maplibre-gl` touches `window` at import time, so the map must not be part of
 * the server render. `ssr: false` is only legal inside a Client Component,
 * which is the entire reason this thin wrapper exists — the page itself stays a
 * Server Component that fetches the caller's organization.
 */
const CounterpartyMap = dynamic(
  () =>
    import("@/components/map/counterparty-map").then((m) => m.CounterpartyMap),
  {
    ssr: false,
    loading: () => (
      <div className="border-border bg-muted/40 h-[32rem] animate-pulse rounded-xl border" />
    ),
  },
);

export function MapPanel(props: { origin: LatLng; counterpartyLabel: string }) {
  return <CounterpartyMap {...props} />;
}
