"""Postgres access for the ml subsystem.

One connection helper, one bootstrap, one truncate. Everything else in `ml/`
talks to the database through this module so the DSN is resolved in exactly one
place and the "am I about to write to the wrong database?" question has a
single answer.

## This is not FFE's database

The corpus lives in its own Postgres (`docker-compose.yml`, port 55432), not in
Supabase. That separation is not incidental:

- The corpus is **truncated and regenerated** on every `make data`. The
  production log is append-only and enforces it with a trigger; pointing this
  at Supabase would either fail on the truncate or, worse, succeed against a
  database that was supposed to be immutable.
- The ml side reads production with the **service-role key**, which bypasses
  RLS entirely. Keeping generation on a separate database means no code path
  that writes can also be pointed at production by an environment variable.

`ML_DATABASE_URL` is therefore expected to be a local corpus database, and
`assert_not_supabase` refuses the obvious mistake — the same guard, and the
same reasoning, as `supabase/seed/run.ts` warning when its target is not
localhost.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg_pool import ConnectionPool

__all__ = [
    "DEFAULT_DSN",
    "assert_not_supabase",
    "bootstrap",
    "connect",
    "connection_pool",
    "resolve_dsn",
    "truncate_events",
]

#: Matches the `postgres` service in the repo-root `docker-compose.yml`.
#: Port 55432 rather than 5432 so it cannot collide with a system Postgres, and
#: not 54322 either — that is local Supabase, which is a different database with
#: a different purpose and is often running at the same time.
DEFAULT_DSN = "postgresql://ffe_ml:ffe_ml@localhost:55432/ffe_ml"

SQL_DIR = Path(__file__).resolve().parent.parent.parent / "sql"


class UnsafeTargetError(RuntimeError):
    """The configured database looks like something that must not be written."""


def assert_not_supabase(dsn: str) -> None:
    """Refuse a DSN pointing at a Supabase project.

    A generated corpus written into the production event log would be
    indistinguishable from real history the moment it landed, and the log is
    append-only, so there would be no clean way back. Cheap check, unrecoverable
    mistake.
    """
    lowered = dsn.lower()
    for marker in ("supabase.co", "supabase.com", "pooler.supabase"):
        if marker in lowered:
            raise UnsafeTargetError(
                f"refusing to use a Supabase DSN for the ml corpus (matched {marker!r}). "
                "The corpus is generated and truncated; production events are append-only. "
                "Point ML_DATABASE_URL at the local corpus database instead."
            )


def resolve_dsn(dsn: str | None = None) -> str:
    resolved = dsn or os.environ.get("ML_DATABASE_URL") or DEFAULT_DSN
    assert_not_supabase(resolved)
    return resolved


@contextmanager
def connect(dsn: str | None = None) -> Iterator[psycopg.Connection]:
    """A connection with autocommit off; commits on clean exit."""
    with psycopg.connect(resolve_dsn(dsn)) as conn:
        yield conn


def bootstrap(conn: psycopg.Connection) -> list[str]:
    """Apply every file in `ml/sql/`, in name order. Idempotent.

    These are bootstrap DDL, not migrations — see the header of
    `ml/sql/002_ml_tables.sql`. Every statement is `create ... if not exists`,
    so re-running is a no-op and a schema *change* needs `make db-reset`.
    """
    applied: list[str] = []
    for path in sorted(SQL_DIR.glob("*.sql")):
        conn.execute(path.read_text(encoding="utf-8"))
        applied.append(path.name)
    conn.commit()
    return applied


def truncate_events(conn: psycopg.Connection) -> None:
    """Empty the corpus so a run replaces it rather than appending to it.

    `restart identity` matters: `events.id` is the pipeline's tie-break inside
    an `occurred_at` group, so leaving the sequence where it was would make two
    runs of the same seed produce different ids for identical events and break
    the byte-identical claim at the database layer.
    """
    conn.execute("truncate table public.events restart identity")
    conn.commit()


def connection_pool(dsn: str | None = None, min_size: int = 1, max_size: int = 8) -> ConnectionPool:
    """A pool for the serving path, resolved through the same guard.

    `connect` opens a connection per call, which is right for the batch jobs —
    they open one and hold it for the length of a run. The scoring service is
    the opposite shape: many short writes to `predictions`, concurrently. A
    single shared connection would serialise them behind one protocol
    conversation and show up directly in the p99 the milestone has to report.

    Goes through `resolve_dsn` rather than reading the environment itself, so
    the Supabase refusal applies here too. Nothing about serving should be able
    to reach a database `connect` would decline.
    """
    return ConnectionPool(resolve_dsn(dsn), min_size=min_size, max_size=max_size, open=True)
