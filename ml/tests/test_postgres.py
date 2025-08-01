"""Integration: the SQL bootstrap and the COPY path, against a real Postgres.

Skipped unless `ML_TEST_POSTGRES=1`. CI sets it and provides a service
container; locally, `make test-pg` after `make db-up`.

These are the tests that would have caught the two mistakes M11 actually made:
a syntax error in `ml/sql/` (which nothing else parses) and a COPY that aborted
on its first row because psycopg's context manager had been driven by hand.
Neither is visible to a JSONL run.
"""

from __future__ import annotations

import os

import pytest

from ml.db import UnsafeTargetError, assert_not_supabase, bootstrap, connect, truncate_events
from ml.events import EVENT_TYPES, PAYLOAD_KEYS
from ml.simulate.config import SimulationConfig
from ml.simulate.engine import simulate
from ml.simulate.sink import PostgresSink, drain
from tests.conftest import corpus_test_dsn

pytestmark = pytest.mark.skipif(
    os.environ.get("ML_TEST_POSTGRES") != "1",
    reason="needs a corpus database; set ML_TEST_POSTGRES=1 (CI does)",
)

SMALL = SimulationConfig(seed=31337, months=1, n_donors=50, n_recipients=35)


@pytest.fixture(scope="module")
def dsn() -> str:
    """The throwaway database. NOT the corpus — see `corpus_test_dsn`."""
    return corpus_test_dsn()


def _load_corpus(conn) -> None:  # type: ignore[no-untyped-def]
    """Replace whatever is in `events` with one run of `SMALL`."""
    truncate_events(conn)
    events, _stats = simulate(SMALL)
    drain(events, PostgresSink(conn))


@pytest.fixture(scope="module")
def corpus_conn(dsn: str):  # type: ignore[no-untyped-def]
    """A bootstrapped throwaway database holding one small corpus."""
    with connect(dsn) as conn:
        bootstrap(conn)
        _load_corpus(conn)
        yield conn


def test_bootstrap_creates_every_table(dsn: str) -> None:
    with connect(dsn) as conn:
        applied = bootstrap(conn)
        assert applied == ["001_events.sql", "002_ml_tables.sql"]
        rows = conn.execute(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' order by table_name"
        ).fetchall()
    present = {row[0] for row in rows}
    for table in ("events", "features_waste", "listing_risk", "metric_history", "predictions"):
        assert table in present


def test_bootstrap_is_idempotent(dsn: str) -> None:
    """It runs on every `make data`, so a second application must be a no-op."""
    with connect(dsn) as conn:
        bootstrap(conn)
        bootstrap(conn)


def test_copy_writes_every_event(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    total = corpus_conn.execute("select count(*) from public.events").fetchone()[0]
    events, stats = simulate(SMALL)
    expected = sum(1 for _ in events)
    assert total == expected == stats.events


def test_all_five_types_survive_the_round_trip(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    rows = corpus_conn.execute(
        "select event_type, count(*) from public.events group by 1"
    ).fetchall()
    counts = dict(rows)
    for event_type in EVENT_TYPES:
        assert counts.get(event_type, 0) > 0


def test_payload_keys_survive_the_round_trip(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    """jsonb reorders keys on the way in. The *set* must still be exact."""
    for event_type in EVENT_TYPES:
        row = corpus_conn.execute(
            "select payload from public.events where event_type = %s limit 1",
            (event_type,),
        ).fetchone()
        assert row is not None
        assert tuple(sorted(row[0])) == PAYLOAD_KEYS[event_type]


def test_check_constraint_rejects_an_unknown_event_type(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    """The corpus table must reject what production would reject — including
    the `listing_expired` that deliberately does not exist."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation), corpus_conn.transaction():
        corpus_conn.execute(
            "insert into public.events (event_type, payload) values ('listing_expired', '{}')"
        )


def test_occurred_at_and_id_form_a_forward_cursor(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    """Rows are inserted in chronological order, so ids ascend with time. That
    is what lets the ml side read "everything since (t, id)" without a sort."""
    out_of_order = corpus_conn.execute(
        """
        select count(*) from (
          select occurred_at,
                 lag(occurred_at) over (order by id) as previous
          from public.events
        ) t
        where previous is not null and occurred_at < previous
        """
    ).fetchone()[0]
    assert out_of_order == 0


def test_truncate_restarts_identity(corpus_conn) -> None:  # type: ignore[no-untyped-def]
    """Otherwise two runs of the same seed give identical events different ids,
    and the byte-identical claim stops holding at the database layer.

    This test replaces the module corpus, so it puts it back. Leaving it broken
    would make every other test in this file depend on running before this one
    — which they would, today, purely because pytest happens to execute a file
    top to bottom. That is not a property worth relying on.
    """
    try:
        truncate_events(corpus_conn)
        events, _ = simulate(SimulationConfig(seed=1, months=1, n_donors=5, n_recipients=5))
        drain(events, PostgresSink(corpus_conn))
        first_id = corpus_conn.execute("select min(id) from public.events").fetchone()[0]
        assert first_id == 1
    finally:
        _load_corpus(corpus_conn)


@pytest.mark.parametrize(
    "bad_dsn",
    [
        "postgresql://x:y@db.abcdefgh.supabase.co:5432/postgres",
        "postgresql://x:y@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    ],
)
def test_supabase_dsn_is_refused(bad_dsn: str) -> None:
    """A generated corpus written into the production log would be
    indistinguishable from real history the moment it landed — and the log is
    append-only, so there is no clean way back."""
    with pytest.raises(UnsafeTargetError):
        assert_not_supabase(bad_dsn)
