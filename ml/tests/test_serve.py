"""The scoring API.

Most of this runs without a database: the model bundle is committed, and a
hand-written event source is enough to exercise the contract, the status codes
and the metrics. The two tests that need the corpus are the ones that are only
meaningful against it — that the serving path and the batch pipeline produce the
**same feature vector** for the same listing at the same instant, and that a
score lands in `predictions`.

That first one is the point of the whole serving half. `features_hash` exists to
detect training/serving skew in production; here it is used to prove there is
none to detect.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ml.features.digest import encode_value, features_hash
from ml.features.log import LogEvent
from ml.features.spec import FEATURE_NAMES
from ml.serve.app import create_app
from ml.serve.scoring import ScoringService

needs_postgres = pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs the corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)

T0 = datetime.fromisoformat("2025-03-01T08:00:00+00:00")
DONOR = "11111111-1111-4111-8111-111111111111"
LISTING = "33333333-3333-4333-8333-333333333333"
ABSENT = "99999999-9999-4999-8999-999999999999"


class _FakeSource:
    """A two-event log, so the API can be tested without a corpus."""

    def __init__(self) -> None:
        self._events = [
            LogEvent(
                occurred_at=T0,
                event_type="listing_posted",
                listing_id=LISTING,
                claim_id=None,
                actor_org_id=DONOR,
                payload={
                    "donor_org_id": DONOR,
                    "donor_lat": 41.88,
                    "donor_lng": -87.63,
                    "donor_verified": True,
                    "title": "Day-old bread",
                    "quantity": "12 trays",
                    "notes_length": 40,
                    "pickup_start": (T0 + timedelta(hours=1)).isoformat(),
                    "pickup_end": (T0 + timedelta(hours=12)).isoformat(),
                },
            )
        ]

    def claim(self, at: datetime) -> None:
        self._events.append(
            LogEvent(
                occurred_at=at,
                event_type="listing_claimed",
                listing_id=LISTING,
                claim_id="44444444-4444-4444-8444-444444444444",
                actor_org_id="22222222-2222-4222-8222-222222222222",
                payload={
                    "donor_org_id": DONOR,
                    "recipient_org_id": "22222222-2222-4222-8222-222222222222",
                    "recipient_lat": 41.90,
                    "recipient_lng": -87.62,
                },
            )
        )

    def replay(self, until: datetime | None) -> Any:
        for event in self._events:
            if until is not None and event.occurred_at > until:
                return
            yield event

    def latest_event_at(self) -> datetime:
        return max(event.occurred_at for event in self._events)


@pytest.fixture
def client() -> Any:
    service = ScoringService(source=_FakeSource(), log_predictions=False)
    with TestClient(create_app(service)) as test_client:
        yield test_client


def _body(**overrides: Any) -> dict[str, Any]:
    return {"listing_id": LISTING, "as_of": T0.isoformat(), **overrides}


# -- the contract -----------------------------------------------------------


def test_as_of_is_required() -> None:
    """The brief's sharpest API decision, asserted rather than documented.

    There is no `now` default on purpose: the corpus ends 2025-07-07, so a
    wall-clock default would make every listing read as long expired and the
    failure would look like a modelling problem.
    """
    service = ScoringService(source=_FakeSource(), log_predictions=False)
    with TestClient(create_app(service)) as test_client:
        response = test_client.post("/score/waste", json={"listing_id": LISTING})

    assert response.status_code == 422
    missing = [error for error in response.json()["detail"] if error["type"] == "missing"]
    assert [error["loc"] for error in missing] == [["body", "as_of"]]


def test_a_malformed_listing_id_is_rejected(client: TestClient) -> None:
    response = client.post("/score/waste", json=_body(listing_id="not-a-uuid"))
    assert response.status_code == 422


def test_unexpected_fields_are_rejected(client: TestClient) -> None:
    """`extra="forbid"`, so a caller misspelling `as_of` hears about it."""
    response = client.post("/score/waste", json=_body(asof=T0.isoformat()))
    assert response.status_code == 422


def test_scoring_a_known_listing(client: TestClient) -> None:
    response = client.post("/score/waste", json=_body(as_of=(T0 + timedelta(hours=2)).isoformat()))

    assert response.status_code == 200
    payload = response.json()
    assert 0.0 <= payload["score"] <= 1.0
    assert payload["risk_tier"] in {"low", "medium", "high"}
    assert payload["model_version"].startswith("model_a-v1-")
    assert payload["features_hash"].startswith("v1:")


def test_an_unknown_listing_is_404(client: TestClient) -> None:
    response = client.post("/score/waste", json=_body(listing_id=ABSENT))
    assert response.status_code == 404
    assert "not in the log" in response.json()["detail"]


def test_an_as_of_before_the_cursor_is_422_not_500(client: TestClient) -> None:
    """A well-formed, unanswerable request.

    The state has already been replayed past that instant, so any answer would
    have the future folded into it. Refusing is correct; refusing with a 500
    would make a correctness guard look like a crash.
    """
    response = client.post("/score/waste", json=_body(as_of=(T0 - timedelta(hours=1)).isoformat()))
    assert response.status_code == 422
    assert "precedes" in response.json()["detail"]


def test_a_naive_as_of_is_read_as_utc(client: TestClient) -> None:
    response = client.post("/score/waste", json=_body(as_of="2025-03-01T10:00:00"))
    assert response.status_code == 200
    assert response.json()["as_of"].startswith("2025-03-01T10:00:00")


def test_a_claimed_listing_is_409_not_a_confident_score() -> None:
    """Out of distribution, and the model would answer anyway.

    Every training row came from an open listing. Nothing stops the booster
    producing a number for a claimed one, and that number would look exactly as
    trustworthy as any other — which is the problem.
    """
    source = _FakeSource()
    source.claim(T0 + timedelta(hours=1))
    service = ScoringService(source=source, log_predictions=False)

    with TestClient(create_app(service)) as test_client:
        response = test_client.post(
            "/score/waste", json=_body(as_of=(T0 + timedelta(hours=2)).isoformat())
        )

    assert response.status_code == 409
    assert "is claimed at" in response.json()["detail"]


def test_a_listing_past_its_pickup_window_is_409() -> None:
    service = ScoringService(source=_FakeSource(), log_predictions=False)

    with TestClient(create_app(service)) as test_client:
        response = test_client.post(
            "/score/waste", json=_body(as_of=(T0 + timedelta(hours=20)).isoformat())
        )

    assert response.status_code == 409
    assert "is expired at" in response.json()["detail"]


def test_open_listings_is_the_population_the_batch_scorer_will_use() -> None:
    source = _FakeSource()
    service = ScoringService(source=source, log_predictions=False)
    service.warm()

    assert service.open_listings() == [LISTING]
    # Past the pickup window, nothing is on offer.
    assert service.open_listings(T0 + timedelta(hours=20)) == []


# -- health and metrics -----------------------------------------------------


def test_healthz_reports_the_loaded_model(client: TestClient) -> None:
    response = client.get("/healthz")
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "ok"
    assert payload["model_loaded"] is True
    assert payload["features"] == len(FEATURE_NAMES)
    # No pool when prediction logging is off, which is a skip rather than a
    # failure to reach a database that was never opened.
    assert payload["database"] == "skipped"
    assert payload["events_replayed"] == 1


def test_metrics_counts_requests_and_scores(client: TestClient) -> None:
    client.post("/score/waste", json=_body())
    client.post("/score/waste", json=_body(listing_id=ABSENT))

    body = client.get("/metrics").text

    assert 'ffe_ml_requests_total{endpoint="/score/waste",status="200"} 1' in body
    assert 'ffe_ml_requests_total{endpoint="/score/waste",status="404"} 1' in body
    assert "ffe_ml_scores_total 1" in body
    assert "ffe_ml_score_latency_seconds_count 1" in body
    assert 'ffe_ml_score_latency_seconds_bucket{le="+Inf"} 1' in body


# -- the digest -------------------------------------------------------------


def test_booleans_do_not_collide_with_integers() -> None:
    """`True == 1` in Python, and a digest that encoded them alike would lie."""
    assert encode_value(True) == "true"
    assert encode_value(1) == "1"
    assert encode_value(None) == "null"
    assert encode_value(True) != encode_value(1)


def test_hashing_a_partial_vector_raises() -> None:
    partial = dict.fromkeys(FEATURE_NAMES, 0.0)
    del partial["donor_verified"]

    with pytest.raises(KeyError, match="donor_verified"):
        features_hash(partial)


def test_the_digest_notices_a_changed_value() -> None:
    base: dict[str, Any] = dict.fromkeys(FEATURE_NAMES, 0.0)
    changed = {**base, "recipients_within_5km": 1.0}

    assert features_hash(base) == features_hash(dict(base))
    assert features_hash(base) != features_hash(changed)


# -- against the corpus -----------------------------------------------------


@needs_postgres
def test_serving_features_match_the_training_row_exactly() -> None:
    """No training/serving skew, proved rather than assumed.

    Takes a real `features_waste` row — the exact grain the model was trained
    on — replays the log to that row's `as_of`, and asserts the serving path
    produces a byte-identical feature vector. The comparison is by digest, which
    is the same thing `predictions.features_hash` records in production, so this
    test exercises the detector as well as the thing detected.
    """
    from ml.db import connect

    columns = ", ".join(FEATURE_NAMES)
    with connect() as conn:
        row = conn.execute(
            f"select listing_id, as_of, {columns} from public.features_waste "
            "where split = 'val' order by as_of desc limit 1"
        ).fetchone()
        if row is None:
            pytest.skip("no corpus in this database; run `make reproduce`")

    listing_id, as_of = str(row[0]), row[1]
    stored = dict(zip(FEATURE_NAMES, row[2:], strict=True))

    service = ScoringService(log_predictions=False, cursor=as_of)
    service.warm()
    result = service.score(listing_id, as_of)
    service.close()

    assert result.features_hash == features_hash(stored), (
        "the serving path and the batch pipeline disagree; differing features: "
        + ", ".join(
            name
            for name in FEATURE_NAMES
            if encode_value(result.features[name]) != encode_value(stored[name])
        )
    )


@needs_postgres
def test_every_score_writes_a_predictions_row() -> None:
    from ml.db import connect

    with connect() as conn:
        row = conn.execute(
            "select listing_id, as_of from public.features_waste order by as_of desc limit 1"
        ).fetchone()
        if row is None:
            pytest.skip("no corpus in this database; run `make reproduce`")
    listing_id, as_of = str(row[0]), row[1]

    service = ScoringService(cursor=as_of)
    service.warm()
    try:
        with connect() as conn:
            before = conn.execute(
                "select count(*) from public.predictions where listing_id = %s", (listing_id,)
            ).fetchone()
        result = service.score(listing_id, as_of)
        with connect() as conn:
            after = conn.execute(
                "select model_version, score, features_hash from public.predictions "
                "where listing_id = %s order by served_at desc limit 1",
                (listing_id,),
            ).fetchone()
    finally:
        service.close()

    assert before is not None and after is not None
    assert after[0] == result.model_version
    assert after[1] == pytest.approx(result.score)
    assert after[2] == result.features_hash


@needs_postgres
def test_the_service_scores_at_an_as_of_later_than_the_log() -> None:
    """The live-serving shape: state built to a cursor, scored a bit after it.

    `hours_to_pickup_end` has to shrink even though no event happened in
    between. If it did not, a listing would be scored on a stale clock — which
    is exactly the case a batch scorer running on the hour hits every time.
    """
    from ml.db import connect

    with connect() as conn:
        row = conn.execute(
            "select listing_id, as_of from public.features_waste "
            "where hours_to_pickup_end > 3 order by as_of desc limit 1"
        ).fetchone()
        if row is None:
            pytest.skip("no corpus in this database; run `make reproduce`")
    listing_id, as_of = str(row[0]), row[1]

    service = ScoringService(log_predictions=False, cursor=as_of)
    service.warm()
    try:
        at_cursor = service.score(listing_id, as_of)
        later = service.score(listing_id, as_of + timedelta(hours=2))
    finally:
        service.close()

    assert later.features["hours_to_pickup_end"] == pytest.approx(
        at_cursor.features["hours_to_pickup_end"] - 2.0
    )
    assert later.features["hours_since_posted"] == pytest.approx(
        at_cursor.features["hours_since_posted"] + 2.0
    )
    assert later.features_hash != at_cursor.features_hash


def test_utc_is_the_only_timezone_in_play() -> None:
    """A guard on the fixture rather than on the code, but a cheap one."""
    assert T0.tzinfo is UTC
