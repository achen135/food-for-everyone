"""The batch scorer.

Most of this needs no database: a hand-written event source and an in-memory
writer exercise the whole loop, the pruning rule and the source/sink coupling.
The corpus-backed tests are the ones that are only meaningful against real data
— that the batch job scores exactly the population `FeatureState` calls open,
that its features are the pipeline's features, and that a second run changes
nothing.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Iterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from ml.batch.__main__ import resolve_as_of, run_batch
from ml.batch.writeback import CorpusRiskWriter, ListingRiskWriter, RiskRow, writer_for
from ml.features.digest import features_hash
from ml.features.log import LogEvent
from ml.features.pipeline import FeatureState
from ml.serve.scoring import ScoringService
from ml.serve.sources import CorpusEventSource

needs_postgres = pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs the corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)

T0 = datetime.fromisoformat("2025-03-01T08:00:00+00:00")
CORPUS_AS_OF = datetime.fromisoformat("2025-06-13T23:00:00+00:00")

DONOR = "11111111-1111-4111-8111-111111111111"
OPEN_LISTING = "33333333-3333-4333-8333-333333333333"
CLOSED_LISTING = "55555555-5555-4555-8555-555555555555"


def _posted(listing_id: str, at: datetime, window_hours: int) -> LogEvent:
    return LogEvent(
        occurred_at=at,
        event_type="listing_posted",
        listing_id=listing_id,
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
            "pickup_start": (at + timedelta(hours=1)).isoformat(),
            "pickup_end": (at + timedelta(hours=window_hours)).isoformat(),
        },
    )


class _FakeSource:
    """One listing still open at T0+2h, one whose window shut at T0+1h."""

    def __init__(self) -> None:
        self._events = [
            _posted(OPEN_LISTING, T0, window_hours=12),
            _posted(CLOSED_LISTING, T0, window_hours=1),
        ]

    def replay(self, until: datetime | None) -> Iterator[LogEvent]:
        for event in self._events:
            if until is not None and event.occurred_at > until:
                return
            yield event

    def latest_event_at(self) -> datetime:
        return max(event.occurred_at for event in self._events)


class _MemoryWriter:
    """A `RiskWriter` that keeps rows in a dict, so the loop is assertable."""

    def __init__(self) -> None:
        self.rows: dict[str, RiskRow] = {}
        self.upsert_calls = 0

    @property
    def label(self) -> str:
        return "memory"

    def upsert(self, rows: Sequence[RiskRow]) -> int:
        self.upsert_calls += 1
        for row in rows:
            self.rows[row.listing_id] = row
        return len(rows)

    def existing_ids(self) -> set[str]:
        return set(self.rows)

    def prune(self, keep: Iterable[str]) -> int:
        stale = set(self.rows) - set(keep)
        for listing_id in stale:
            del self.rows[listing_id]
        return len(stale)


# -- the loop ---------------------------------------------------------------


def test_only_open_listings_are_scored() -> None:
    """A listing past its pickup window is out of distribution, not low-risk.

    The model was trained only on open-listing observations, so scoring a shut
    listing would return a confident number nothing in the evaluation covers.
    `is_open` is the same question the endpoint asks.
    """
    writer = _MemoryWriter()
    report = run_batch(
        "corpus",
        (T0 + timedelta(hours=2)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        log_predictions=False,
    )

    assert report.open_listings == 1
    assert report.scored == 1
    assert set(writer.rows) == {OPEN_LISTING}
    assert CLOSED_LISTING not in writer.rows


def test_a_second_run_writes_identical_rows() -> None:
    """Idempotence, which is what `scored_at = as_of` buys.

    Had `scored_at` been `now()`, every run would rewrite every row with a new
    timestamp and "did anything change?" would be unanswerable.
    """
    writer = _MemoryWriter()
    as_of = (T0 + timedelta(hours=2)).isoformat()

    run_batch("corpus", as_of, source=_FakeSource(), writer=writer, log_predictions=False)
    first = dict(writer.rows)
    run_batch("corpus", as_of, source=_FakeSource(), writer=writer, log_predictions=False)

    assert writer.rows == first


def test_rows_for_listings_that_closed_are_pruned() -> None:
    """`listing_risk` is current state, so a closed listing loses its row."""
    writer = _MemoryWriter()

    run_batch(
        "corpus",
        (T0 + timedelta(hours=2)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        log_predictions=False,
    )
    assert set(writer.rows) == {OPEN_LISTING}

    # Later than every pickup window: nothing is open any more.
    report = run_batch(
        "corpus",
        (T0 + timedelta(hours=99)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        log_predictions=False,
    )

    assert report.scored == 0
    assert report.pruned == 1
    assert writer.rows == {}


def test_no_prune_keeps_stale_rows() -> None:
    writer = _MemoryWriter()
    run_batch(
        "corpus",
        (T0 + timedelta(hours=2)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        log_predictions=False,
    )
    run_batch(
        "corpus",
        (T0 + timedelta(hours=99)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        prune=False,
        log_predictions=False,
    )
    assert set(writer.rows) == {OPEN_LISTING}


def test_dry_run_writes_nothing() -> None:
    writer = _MemoryWriter()
    report = run_batch(
        "corpus",
        (T0 + timedelta(hours=2)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        dry_run=True,
        log_predictions=False,
    )
    assert report.scored == 1
    assert report.written == 0
    assert writer.upsert_calls == 0
    assert writer.rows == {}


def test_every_scored_row_carries_a_tier_and_a_version() -> None:
    writer = _MemoryWriter()
    run_batch(
        "corpus",
        (T0 + timedelta(hours=2)).isoformat(),
        source=_FakeSource(),
        writer=writer,
        log_predictions=False,
    )
    row = writer.rows[OPEN_LISTING]
    assert row.risk_tier in {"low", "medium", "high"}
    assert 0.0 <= row.score <= 1.0
    assert row.model_version.startswith("model_a-")
    assert row.scored_at == T0 + timedelta(hours=2)


# -- the source/sink coupling -----------------------------------------------


def test_the_corpus_source_writes_to_the_corpus() -> None:
    assert isinstance(writer_for("corpus"), CorpusRiskWriter)


def test_an_unknown_source_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown event source"):
        writer_for("staging")


def test_the_production_writer_needs_a_supabase_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mirror guard: the one path that writes production refuses anything else.

    `ml.db` refuses a Supabase DSN so the corpus generator can never reach
    production. This is the same fence facing the other way — a batch run
    configured with a corpus URL must not send production-shaped writes at it.
    """
    from ml.supabase_rest import NotSupabaseError

    monkeypatch.setenv("FFE_SUPABASE_SERVICE_ROLE_KEY", "not-a-real-key")

    # The corpus DSN is caught on the scheme, before the host is considered —
    # this client speaks PostgREST over HTTP and a Postgres DSN is never it.
    monkeypatch.setenv("FFE_SUPABASE_URL", "postgresql://ffe_ml@localhost:55432/ffe_ml")
    with pytest.raises(NotSupabaseError, match="expected an http"):
        ListingRiskWriter()

    # An http URL that is simply somewhere else is caught on the host.
    monkeypatch.setenv("FFE_SUPABASE_URL", "https://example.com")
    with pytest.raises(NotSupabaseError, match="does not look like"):
        ListingRiskWriter()


def test_local_supabase_is_allowed_so_the_write_path_can_be_rehearsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pointing the production path at local Supabase must work.

    It is what turns "push to production and hope" into a dry run. The corpus
    is still unreachable from here — it is a `postgresql://` DSN, refused on
    the scheme — so allowing localhost costs the guard nothing.
    """
    monkeypatch.setenv("FFE_SUPABASE_URL", "http://127.0.0.1:54321")
    monkeypatch.setenv("FFE_SUPABASE_SERVICE_ROLE_KEY", "not-a-real-key")
    assert ListingRiskWriter().label.startswith("production listing_risk")


def test_the_corpus_connection_still_refuses_supabase() -> None:
    """M13's guard is untouched by M14 adding a second, narrower door."""
    from ml.db import UnsafeTargetError, resolve_dsn

    with pytest.raises(UnsafeTargetError):
        resolve_dsn("postgresql://postgres@db.abcdefgh.supabase.co:5432/postgres")


def test_the_production_event_source_cannot_write(monkeypatch: pytest.MonkeyPatch) -> None:
    """Read-only is structural, not a convention."""
    from ml.serve.sources import ProductionEventSource
    from ml.supabase_rest import ReadOnlyClientError

    monkeypatch.setenv("FFE_SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("FFE_SUPABASE_SERVICE_ROLE_KEY", "not-a-real-key")
    source = ProductionEventSource()
    with pytest.raises(ReadOnlyClientError):
        source._rest.upsert("listing_risk", [{"listing_id": "x"}], on_conflict="listing_id")


# -- as_of resolution -------------------------------------------------------


def test_production_defaults_to_now() -> None:
    before = datetime.now(UTC)
    resolved = resolve_as_of("production", None, _FakeSource())
    assert before <= resolved <= datetime.now(UTC)


def test_an_explicit_as_of_wins_over_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ML_SERVE_AS_OF", "2025-01-01T00:00:00+00:00")
    assert resolve_as_of(
        "corpus", "2025-05-05T05:00:00+00:00", _FakeSource()
    ) == datetime.fromisoformat("2025-05-05T05:00:00+00:00")


def test_a_naive_as_of_is_read_as_utc() -> None:
    assert resolve_as_of("corpus", "2025-05-05T05:00:00", _FakeSource()).tzinfo is UTC


def test_the_corpus_falls_back_to_its_last_event(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never `now` against the corpus — that is the M13 trap this encodes."""
    monkeypatch.delenv("ML_SERVE_AS_OF", raising=False)
    assert resolve_as_of("corpus", None, _FakeSource()) == T0


# -- against the real corpus ------------------------------------------------


@needs_postgres
def test_the_batch_population_is_exactly_feature_states_open_listings() -> None:
    source = CorpusEventSource()
    state = FeatureState()
    for event in source.replay(CORPUS_AS_OF):
        state.apply(event)
    state.advance_to(CORPUS_AS_OF)
    expected = set(state.open_listings(CORPUS_AS_OF))

    writer = _MemoryWriter()
    report = run_batch(
        "corpus",
        CORPUS_AS_OF.isoformat(),
        source=source,
        writer=writer,
        log_predictions=False,
    )

    assert report.scored == len(expected)
    assert set(writer.rows) == expected


@needs_postgres
def test_batch_features_are_the_pipelines_features() -> None:
    """The skew guard, once more, at the batch layer.

    A batch job that computed features its own way would produce plausible
    wrong tiers rather than an error. Rebuilding the state independently and
    hashing the feature vector is the same check `features_hash` performs in
    production, run here against a path that has no reason to disagree — and
    therefore must not.
    """
    source = CorpusEventSource()
    service = ScoringService(source=source, cursor=CORPUS_AS_OF, log_predictions=False)
    service.warm()

    independent = FeatureState()
    for event in source.replay(CORPUS_AS_OF):
        independent.apply(event)
    independent.advance_to(CORPUS_AS_OF)

    try:
        sampled = service.open_listings(CORPUS_AS_OF)[:50]
        assert sampled, "the pinned instant should have open listings"
        for listing_id in sampled:
            served = service.score(listing_id, CORPUS_AS_OF)
            rebuilt = independent.snapshot(listing_id, CORPUS_AS_OF)
            assert served.features_hash == features_hash(rebuilt)
    finally:
        service.close()


@needs_postgres
def test_a_corpus_run_round_trips_through_listing_risk() -> None:
    """The upsert conflict path, against real Postgres.

    Runs twice on purpose: the first pass inserts, the second takes the
    `on conflict do update` branch, and the rows must be identical either way.
    """
    from ml.db import connect

    writer = CorpusRiskWriter()
    rows = [
        RiskRow(
            listing_id="aaaaaaaa-1111-4111-8111-111111111111",
            risk_tier="high",
            score=0.91,
            model_version="test-version",
            scored_at=CORPUS_AS_OF,
        )
    ]

    def read() -> Any:
        with connect() as conn:
            return conn.execute(
                "select listing_id, risk_tier, score, model_version, scored_at "
                "from public.listing_risk where model_version = 'test-version'"
            ).fetchall()

    try:
        writer.upsert(rows)
        first = read()
        assert len(first) == 1

        changed = [
            RiskRow(
                listing_id=rows[0].listing_id,
                risk_tier="low",
                score=0.02,
                model_version="test-version",
                scored_at=CORPUS_AS_OF,
            )
        ]
        writer.upsert(changed)
        second = read()

        assert len(second) == 1, "the conflict branch must update, not insert a duplicate"
        assert second[0][1] == "low"
        assert second[0][2] == pytest.approx(0.02)
    finally:
        with connect() as conn:
            conn.execute("delete from public.listing_risk where model_version = 'test-version'")
