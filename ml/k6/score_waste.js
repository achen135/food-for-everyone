/**
 * k6 load test for POST /score/waste (docs/ML Subsystem.md §5, M13).
 *
 *   docker compose up -d ml-api
 *   k6 run ml/k6/score_waste.js
 *
 * The résumé's "p99 < N ms" may only cite a number this committed script
 * produced (ML Subsystem §6), so the configuration below is fixed rather than
 * tuned per run, and every choice in it is written down.
 *
 * ## What it scores, and why that list is committed
 *
 * `open_listings.json` holds the 257 listings that are genuinely OPEN at
 * 2025-06-13T23:00:00Z, which is the same instant the `ml-api` service replays
 * its state to. Both halves matter:
 *
 *   - The instant is inside the corpus. The corpus ends 2025-07-07, so driving
 *     this at a real wall-clock `now` would put every listing long past its
 *     pickup window and the service would answer 409 to everything. The result
 *     would be a latency number for an error path.
 *   - The listings are open at it. `/score/waste` refuses a claimed or expired
 *     listing (409), because the model only ever saw open-listing observations,
 *     so a list that had not been filtered would measure rejections.
 *
 * It is one of the corpus's busiest hours, chosen by measuring open listings
 * per hour rather than by picking a plausible-looking timestamp — an arbitrary
 * one gave 25 listings, and cycling 25 ids would describe those ids more than
 * it describes the service.
 *
 * ## Why 4 VUs
 *
 * M7's lesson, one service over: an over-driven local container produces a
 * garbage number. So the level was measured rather than guessed. Sweeping VUs
 * against this stack (15s each, 0% errors throughout):
 *
 *   VUs   req/s    p50      p99      max
 *     1    1239   0.70ms   1.34ms    9.99ms
 *     2    1727   1.03ms   2.04ms   21.49ms
 *     3    1767   1.59ms   2.78ms    8.02ms
 *     4    1686   2.21ms   4.18ms   20.32ms
 *     8    1547   4.88ms   8.78ms  172.37ms
 *    16    1446  10.79ms  17.71ms   57.32ms
 *    32    1386  22.60ms  32.62ms   82.29ms
 *
 * Throughput plateaus around 2-3 VUs and then *declines* while latency grows
 * linearly — the signature of a saturated single worker, where extra VUs only
 * queue. Past the knee the p99 stops describing the service and starts
 * describing the queue in front of it.
 *
 * Pinned at 4: just past the knee, within 5% of peak throughput, and
 * deliberately not the single best point on the curve — a benchmark tuned to
 * its own prettiest number is not a measurement. The p99 reported here is
 * therefore slightly conservative.
 *
 * This is ONE uvicorn worker, which is what `docker-compose.yml` runs. A real
 * deployment would run several and the throughput ceiling would move; the
 * per-request latency would not.
 */

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

const BASE = __ENV.BASE_URL || "http://localhost:8000";
const VUS = Number(__ENV.VUS || 4);
const DURATION = __ENV.DURATION || "30s";

// SharedArray keeps one copy across VUs rather than one per VU.
const fixture = new SharedArray("open listings", () => {
  const parsed = JSON.parse(open("./open_listings.json"));
  return parsed.listing_ids.map((id) => ({ id, asOf: parsed.as_of }));
});

const scoreLatency = new Trend("score_waste_duration", true);

export const options = {
  // k6 reports p(90) and p(95) for a Trend by default and NOT p(99), so without
  // this the milestone's headline number is simply absent from the summary.
  summaryTrendStats: [
    "min",
    "med",
    "p(90)",
    "p(95)",
    "p(99)",
    "max",
    "avg",
    "count",
  ],
  scenarios: {
    score: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // Deliberately loose, and the same reasoning as M7's script: these are a
    // smoke test that the run was valid, not the result. A threshold tuned to
    // the expected answer turns a measurement into a self-fulfilling one.
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  // Startup replays ~269k events into a FeatureState, so the port is open well
  // before the service can answer. Measuring through that window would put the
  // warm-up in the tail.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = http.get(`${BASE}/healthz`);
    if (probe.status === 200) {
      return { cursor: probe.json("replay_cursor") };
    }
    // Busy-wait via a request rather than sleep(): k6's sleep is not available
    // in setup on all builds, and a health probe every ~200ms is harmless.
    http.get(`${BASE}/healthz`, { timeout: "2s" });
  }
  throw new Error(
    "ml-api never became healthy — is `docker compose up -d ml-api` running?",
  );
}

export default function () {
  const target = fixture[Math.floor(Math.random() * fixture.length)];

  const response = http.post(
    `${BASE}/score/waste`,
    JSON.stringify({ listing_id: target.id, as_of: target.asOf }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "score_waste" },
    },
  );

  scoreLatency.add(response.timings.duration);

  check(response, {
    "status is 200": (r) => r.status === 200,
    "score is a probability": (r) => {
      const score = r.json("score");
      return typeof score === "number" && score >= 0 && score <= 1;
    },
    "tier is present": (r) =>
      ["low", "medium", "high"].includes(r.json("risk_tier")),
    "features_hash is present": (r) =>
      String(r.json("features_hash")).startsWith("v1:"),
  });
}

export function handleSummary(data) {
  const metric = data.metrics.score_waste_duration.values;
  const summary = {
    endpoint: "POST /score/waste",
    note: "SIMULATED corpus; see ml/docs/simulator.md. Latency is real, the data is not.",
    vus: VUS,
    duration: DURATION,
    requests: data.metrics.http_reqs.values.count,
    error_rate: data.metrics.http_req_failed.values.rate,
    latency_ms: {
      min: metric.min,
      med: metric.med,
      p90: metric["p(90)"],
      p95: metric["p(95)"],
      p99: metric["p(99)"],
      max: metric.max,
    },
  };
  return {
    stdout: `\n${JSON.stringify(summary, null, 2)}\n`,
    "ml/k6/score_waste.summary.json": `${JSON.stringify(summary, null, 2)}\n`,
  };
}
