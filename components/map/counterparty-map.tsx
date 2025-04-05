"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Map, {
  AttributionControl,
  Layer,
  Marker,
  NavigationControl,
  Popup,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from "react-map-gl/maplibre";
import { setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import { LocateFixedIcon, SearchIcon } from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";

import type { LatLng } from "@/lib/db";
import {
  EMPTY_FEATURE_COLLECTION,
  type OrgFeatureCollection,
  type OrgFeatureProperties,
} from "@/lib/geojson";
import { DEFAULT_RADIUS_KM, RADIUS_OPTIONS_KM } from "@/lib/validation/map";
import {
  CLUSTER_LAYER_ID,
  MAP_ATTRIBUTION,
  OPENFREEMAP_STYLE,
  clusterCountLayer,
  clusterLayer,
  unclusteredPointLayer,
} from "@/components/map/map-layers";
import { OrgPopupCard } from "@/components/map/org-popup-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SOURCE_ID = "counterparties";
const SEARCH_DEBOUNCE_MS = 400;

/**
 * Serve MapLibre's worker ourselves.
 *
 * Left alone, maplibre resolves `./maplibre-gl-worker.mjs` against
 * `import.meta.url` — which under a bundler is the built chunk, not the package
 * directory. It ends up requesting `/_next/static/chunks/maplibre-gl-worker.mjs`,
 * Next answers with its 404 HTML page, and the browser rejects it:
 * "Failed to load module script: ... non-JavaScript MIME type of text/html".
 * The map then renders blank with nothing thrown, because the failure happens
 * during worker startup.
 *
 * `scripts/copy-maplibre-worker.mjs` (predev/prebuild) copies the worker and its
 * `maplibre-gl-shared.mjs` sibling into `public/maplibre/`. Same-origin, so
 * maplibre uses a plain module Worker rather than its cross-origin blob shim.
 *
 * Must run before any Map is constructed — module scope of this client-only,
 * dynamically-imported file is the earliest safe point.
 */
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

interface SelectedOrg {
  properties: OrgFeatureProperties;
  longitude: number;
  latitude: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Narrow a clicked feature's geometry to a point. Every feature in our source
 * is a Point (both from `/api/orgs` and from supercluster), but GeoJSON's type
 * union covers all seven geometry kinds, so this states the assumption once.
 */
function pointCoordinates(geometry: GeoJSON.Geometry): [number, number] | null {
  if (geometry.type !== "Point") return null;
  const [longitude, latitude] = geometry.coordinates;
  return [longitude, latitude];
}

export function CounterpartyMap({
  origin,
  counterpartyLabel,
}: {
  /** Where to centre initially — the caller's own organization. */
  origin: LatLng;
  /** "recipients" or "donors", for copy. */
  counterpartyLabel: string;
}) {
  const mapRef = useRef<MapRef | null>(null);

  const [searchCenter, setSearchCenter] = useState<LatLng>(origin);
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [movedSinceSearch, setMovedSinceSearch] = useState(false);

  const [data, setData] = useState<OrgFeatureCollection>(
    EMPTY_FEATURE_COLLECTION,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [selected, setSelected] = useState<SelectedOrg | null>(null);

  // Debounce the name filter. This hits our own API, not Nominatim, so a short
  // debounce is fine — the geocoder's no-per-keystroke rule doesn't apply here.
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(searchInput),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setStatus("loading");
      const params = new URLSearchParams({
        near: `${searchCenter.latitude},${searchCenter.longitude}`,
        radiusKm: String(radiusKm),
      });
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());

      try {
        const response = await fetch(`/api/orgs?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        setData((await response.json()) as OrgFeatureCollection);
        setStatus("ready");
        setMovedSinceSearch(false);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setData(EMPTY_FEATURE_COLLECTION);
        setStatus("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [searchCenter, radiusKm, debouncedSearch]);

  const handleClick = useCallback((event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature) {
      setSelected(null);
      return;
    }

    // Cluster: zoom to the level where it breaks apart.
    if (feature.layer?.id === CLUSTER_LAYER_ID) {
      const clusterId = feature.properties?.cluster_id as number | undefined;
      const source = mapRef.current?.getSource(SOURCE_ID) as
        GeoJSONSource | undefined;
      if (clusterId === undefined || !source) return;

      const coords = pointCoordinates(feature.geometry);
      if (!coords) return;
      const [longitude, latitude] = coords;

      void source.getClusterExpansionZoom(clusterId).then((zoom) => {
        mapRef.current?.easeTo({
          center: [longitude, latitude],
          zoom,
          duration: prefersReducedMotion() ? 0 : 350,
        });
      });
      return;
    }

    const coords = pointCoordinates(feature.geometry);
    if (!coords) return;
    setSelected({
      properties: feature.properties as unknown as OrgFeatureProperties,
      longitude: coords[0],
      latitude: coords[1],
    });
  }, []);

  /** Re-run the query around wherever the map is now looking. */
  const searchThisArea = useCallback(() => {
    const center = mapRef.current?.getCenter();
    if (!center) return;
    setSelected(null);
    setSearchCenter({ latitude: center.lat, longitude: center.lng });
  }, []);

  const recentre = useCallback(() => {
    setSelected(null);
    mapRef.current?.easeTo({
      center: [origin.longitude, origin.latitude],
      zoom: 11,
      duration: prefersReducedMotion() ? 0 : 350,
    });
    setSearchCenter(origin);
  }, [origin]);

  const count = data.features.length;

  return (
    <div className="grid gap-3">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <Label htmlFor="map-search">Filter by name</Label>
          <Input
            id="map-search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={`Search ${counterpartyLabel}…`}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="map-radius">Within</Label>
          <select
            id="map-radius"
            value={radiusKm}
            onChange={(event) => setRadiusKm(Number(event.target.value))}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3"
          >
            {RADIUS_OPTIONS_KM.map((km) => (
              <option key={km} value={km}>
                {km} km
              </option>
            ))}
          </select>
        </div>

        <Button type="button" variant="outline" onClick={recentre}>
          <LocateFixedIcon />
          My location
        </Button>
      </div>

      {/* Result summary — also the live region for screen readers. */}
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {status === "loading"
          ? "Loading…"
          : status === "error"
            ? "Could not load the map. Try again."
            : `${count} ${count === 1 ? "organization" : "organizations"} within ${radiusKm} km`}
      </p>

      <div className="border-border relative h-[32rem] overflow-hidden rounded-xl border">
        <Map
          ref={mapRef}
          initialViewState={{
            longitude: origin.longitude,
            latitude: origin.latitude,
            zoom: 11,
          }}
          mapStyle={OPENFREEMAP_STYLE}
          style={{ width: "100%", height: "100%" }}
          interactiveLayerIds={[CLUSTER_LAYER_ID, unclusteredPointLayer.id!]}
          onClick={handleClick}
          onMoveEnd={() => setMovedSinceSearch(true)}
          attributionControl={false}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <AttributionControl
            compact
            customAttribution={MAP_ATTRIBUTION}
            position="bottom-right"
          />

          {/* The caller's own location, for orientation. Not a counterparty. */}
          <Marker
            longitude={origin.longitude}
            latitude={origin.latitude}
            anchor="center"
          >
            <span
              className="border-background bg-accent block size-3.5 rounded-full border-2 shadow"
              title="Your organization"
            />
          </Marker>

          <Source
            id={SOURCE_ID}
            type="geojson"
            data={data}
            cluster
            clusterMaxZoom={13}
            clusterRadius={50}
          >
            <Layer {...clusterLayer} />
            <Layer {...clusterCountLayer} />
            <Layer {...unclusteredPointLayer} />
          </Source>

          {selected ? (
            <Popup
              longitude={selected.longitude}
              latitude={selected.latitude}
              anchor="bottom"
              offset={14}
              closeOnClick={false}
              onClose={() => setSelected(null)}
              maxWidth="18rem"
            >
              <OrgPopupCard org={selected.properties} />
            </Popup>
          ) : null}
        </Map>

        {movedSinceSearch && status !== "loading" ? (
          <div className="absolute inset-x-0 top-3 flex justify-center">
            <Button type="button" size="sm" onClick={searchThisArea}>
              <SearchIcon />
              Search this area
            </Button>
          </div>
        ) : null}

        {status === "ready" && count === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center px-4">
            <p className="bg-popover text-popover-foreground ring-foreground/10 rounded-lg px-3 py-2 text-sm shadow ring-1">
              No {counterpartyLabel} within {radiusKm} km. Try a wider radius.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
