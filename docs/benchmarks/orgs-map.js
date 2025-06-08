/**
 * k6 load test for the map query (Spec §9, M7).
 *
 *   k6 run -e COOKIE="$(node -e '…')" docs/benchmarks/orgs-map.js
 *
 * See README.md in this directory — run it through the documented protocol
 * rather than ad hoc, or the two legs aren't comparable.
 *
 * The script is identical for both legs. Only the server's environment differs
 * (`CACHE_DISABLED=1` or not), which is the whole point: if the script changed
 * between runs, the difference in the numbers wouldn't be attributable to the
 * cache.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const COOKIE = __ENV.COOKIE;

if (!COOKIE) {
  throw new Error(
    "COOKIE is required — mint one with docs/benchmarks/mint-session.ts (see README).",
  );
}

const mapQuery = new Trend("map_query_duration", true);

export const options = {
  scenarios: {
    map: {
      executor: "constant-vus",
      // 4 VUs, not 10. Measured 2026-09-02: above ~25 req/s the local Supabase
      // auth container exhausts ephemeral ports to Postgres ("cannot assign
      // requested address") and GoTrue starts 500ing, which the app surfaces as
      // 401. At 10 VUs that was 22% of requests. Those failures are a property
      // of the local stack, not of this application, and they would corrupt both
      // the latency tail and the read counts. 4 VUs sustains 0% errors here.
      //
      // Every authenticated request costs TWO GoTrue round-trips (middleware +
      // route handler each call getUser()), so the auth service saturates at
      // roughly half the request rate you would expect.
      vus: 4,
      duration: "30s",
    },
  },
  thresholds: {
    // Deliberately loose. These are a smoke test that the run was valid, not
    // the result — a threshold tuned to the expected answer would turn a
    // measurement into a self-fulfilling one.
    http_req_failed: ["rate<0.01"],
  },
};

/**
 * A fixed, repeating set of viewports around the seeded Chicago dataset.
 *
 * Repetition is the point: a cache is only worth measuring against traffic that
 * revisits things, and real map use does (a user changes radius, types in the
 * filter, pans back). Wholly unique centres every request would measure a cache
 * that can never hit, which is a straw man rather than a control.
 */
const VIEWPORTS = [
  { lat: 41.8836, lng: -87.627, radius: 25 },
  { lat: 41.8836, lng: -87.627, radius: 50 },
  { lat: 41.9096, lng: -87.6776, radius: 25 },
  { lat: 41.8296, lng: -87.6338, radius: 25 },
  { lat: 41.9686, lng: -87.7086, radius: 50 },
];

const SEARCHES = ["", "", "", "pantry", "kitchen"];

export default function () {
  const v = VIEWPORTS[__ITER % VIEWPORTS.length];
  const q = SEARCHES[__ITER % SEARCHES.length];

  const url =
    `${BASE}/api/orgs?near=${v.lat},${v.lng}&radiusKm=${v.radius}` +
    (q ? `&q=${encodeURIComponent(q)}` : "");

  const res = http.get(url, {
    headers: { Cookie: COOKIE },
    tags: { name: "GET /api/orgs" },
  });

  mapQuery.add(res.timings.duration);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "body is a FeatureCollection": (r) => {
      try {
        return JSON.parse(r.body).type === "FeatureCollection";
      } catch {
        return false;
      }
    },
  });

  // A 429 means the rate limiter is on and is now shaping the latency numbers.
  // Fail loudly rather than quietly reporting a distribution of rejections —
  // the protocol says the limiter is off for this measurement.
  if (res.status === 429) {
    throw new Error(
      "Got 429 — run the benchmark with RATE_LIMIT_DISABLED=1 (see README).",
    );
  }

  sleep(0.1);
}
