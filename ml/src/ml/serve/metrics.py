"""`/metrics` — request counts, score counts, and a latency histogram.

Prometheus text exposition, hand-written rather than via `prometheus_client`.
Three metric families and a fixed bucket list do not justify a dependency in an
image that already has to carry LightGBM, and the format is a dozen lines.

Counters are process-local and reset when the process does, which is what a
scrape-based system expects — the scraper computes rates from the counter's
increase, so a restart shows as a reset rather than as a spike.
"""

from __future__ import annotations

import threading
from typing import Final

__all__ = ["LATENCY_BUCKETS", "Metrics"]

#: Seconds. Dense below 100 ms because that is where the p99 target lives, and
#: a histogram whose first bucket is 1 s cannot answer the question the
#: milestone asks.
LATENCY_BUCKETS: Final[tuple[float, ...]] = (
    0.001,
    0.0025,
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
)


class Metrics:
    """Counters and a histogram, safe to update from the request threadpool."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[tuple[str, int], int] = {}
        self._scores = 0
        self._buckets = [0] * (len(LATENCY_BUCKETS) + 1)
        self._sum = 0.0
        self._count = 0

    def observe_request(self, endpoint: str, status: int) -> None:
        with self._lock:
            key = (endpoint, status)
            self._requests[key] = self._requests.get(key, 0) + 1

    def observe_score(self, seconds: float) -> None:
        with self._lock:
            self._scores += 1
            self._sum += seconds
            self._count += 1
            for position, edge in enumerate(LATENCY_BUCKETS):
                if seconds <= edge:
                    self._buckets[position] += 1
                    break
            else:
                self._buckets[-1] += 1

    def render(self) -> str:
        with self._lock:
            requests = dict(self._requests)
            scores, total, count = self._scores, self._sum, self._count
            buckets = list(self._buckets)

        lines = [
            "# HELP ffe_ml_requests_total Requests handled, by endpoint and status.",
            "# TYPE ffe_ml_requests_total counter",
        ]
        for (endpoint, status), value in sorted(requests.items()):
            lines.append(
                f'ffe_ml_requests_total{{endpoint="{endpoint}",status="{status}"}} {value}'
            )

        lines += [
            "# HELP ffe_ml_scores_total Listings scored.",
            "# TYPE ffe_ml_scores_total counter",
            f"ffe_ml_scores_total {scores}",
            "# HELP ffe_ml_score_latency_seconds Time spent producing a score.",
            "# TYPE ffe_ml_score_latency_seconds histogram",
        ]
        # Prometheus histogram buckets are cumulative: each `le` counts
        # everything at or below it, so they are summed on the way out rather
        # than stored that way.
        running = 0
        for position, edge in enumerate(LATENCY_BUCKETS):
            running += buckets[position]
            lines.append(f'ffe_ml_score_latency_seconds_bucket{{le="{edge}"}} {running}')
        running += buckets[-1]
        lines += [
            f'ffe_ml_score_latency_seconds_bucket{{le="+Inf"}} {running}',
            f"ffe_ml_score_latency_seconds_sum {total}",
            f"ffe_ml_score_latency_seconds_count {count}",
        ]
        return "\n".join(lines) + "\n"
