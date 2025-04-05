import type { LayerProps } from "react-map-gl/maplibre";

/**
 * MapLibre paint expressions take literal colours, not CSS custom properties,
 * so the Spec §8 ramp is repeated here as hex. Keep in step with
 * `app/globals.css`.
 */
const BRAND = "#1F6E43"; // deep pine
const BRAND_SUPPORT = "#8DB580"; // sage
const SURFACE = "#FBFBF8"; // warm off-white, used for outlines

export const CLUSTER_LAYER_ID = "org-clusters";
export const UNCLUSTERED_LAYER_ID = "org-point";

export const clusterLayer: LayerProps = {
  id: CLUSTER_LAYER_ID,
  type: "circle",
  filter: ["has", "point_count"],
  paint: {
    "circle-color": BRAND,
    // Grow the disc in steps as the cluster gets bigger.
    "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 30, 28],
    "circle-stroke-width": 2,
    "circle-stroke-color": SURFACE,
  },
};

export const clusterCountLayer: LayerProps = {
  id: "org-cluster-count",
  type: "symbol",
  filter: ["has", "point_count"],
  layout: {
    "text-field": ["get", "point_count_abbreviated"],
    // OpenFreeMap's Liberty style serves the Noto Sans glyph range. A font name
    // the style doesn't ship silently renders nothing.
    "text-font": ["Noto Sans Bold"],
    "text-size": 12,
  },
  paint: { "text-color": SURFACE },
};

export const unclusteredPointLayer: LayerProps = {
  id: UNCLUSTERED_LAYER_ID,
  type: "circle",
  filter: ["!", ["has", "point_count"]],
  paint: {
    // Verified organizations get the stronger colour; unverified sit back.
    "circle-color": ["case", ["get", "verified"], BRAND, BRAND_SUPPORT],
    "circle-radius": 8,
    "circle-stroke-width": 2,
    "circle-stroke-color": SURFACE,
  },
};

/** No key, no account, no card — see Design Decisions (MapLibre over Mapbox). */
export const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** OpenFreeMap and Nominatim both require visible attribution. */
export const MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
