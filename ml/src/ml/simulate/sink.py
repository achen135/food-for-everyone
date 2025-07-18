"""Where the generated events go: a JSONL file, or Postgres.

Both sinks see the same `Event` objects in the same order, and both run the
contract validator on every one. Validating in the sink rather than in the
engine is deliberate — it is the last point before the data leaves the process,
so it catches a malformed event however it was produced, including by a future
edit to the engine that forgets a payload key.

**JSONL is the reference output.** The determinism test hashes a JSONL stream,
not a table, because a file has an unambiguous byte sequence and a table does
not (physical row order, sequence values and jsonb key ordering are all the
server's business). Postgres output is checked separately, by counting.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable
from pathlib import Path
from types import TracebackType
from typing import IO, Protocol

from psycopg import Connection
from psycopg.types.json import Jsonb

from ml.events import Event, validate_event

__all__ = ["CountingSink", "JsonlSink", "PostgresSink", "Sink"]


class Sink(Protocol):
    def write(self, event: Event) -> None: ...
    def close(self) -> None: ...


class CountingSink:
    """Validates and counts, writes nothing. Used by the volume tests."""

    def __init__(self) -> None:
        self.count = 0

    def write(self, event: Event) -> None:
        validate_event(event)
        self.count += 1

    def close(self) -> None:
        return None


class JsonlSink:
    """One JSON object per line, sorted keys, compact separators.

    `path` of `-` writes to stdout, which is what makes
    `python -m ml.simulate --out jsonl | sha256sum` work as a determinism check
    without a temporary file.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._handle: IO[str]
        if self._path == "-":
            self._handle = sys.stdout
            self._owned = False
        else:
            target = Path(self._path)
            target.parent.mkdir(parents=True, exist_ok=True)
            # newline="\n" so the bytes are identical on every platform. The
            # default translates to os.linesep on Windows, which would make the
            # hash platform-dependent.
            # The handle is owned by the sink and closed in `close()`, so
            # SIM115 is suppressed below: a `with` here would shut the file
            # after the first write, and staying open across the whole stream
            # is the sink's entire job.
            self._handle = open(target, "w", encoding="utf-8", newline="\n")  # noqa: SIM115
            self._owned = True
        self.count = 0

    def write(self, event: Event) -> None:
        validate_event(event)
        self._handle.write(event.to_json_line())
        self._handle.write("\n")
        self.count += 1

    def close(self) -> None:
        self._handle.flush()
        if self._owned:
            self._handle.close()

    def __enter__(self) -> JsonlSink:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class PostgresSink:
    """Streams into `public.events` with COPY.

    COPY rather than executemany because the difference at 300k rows is minutes
    versus seconds, and `make data` is meant to be a step someone actually runs
    rather than one they work around.

    `id` is `generated always as identity` and is not supplied: rows get their
    ids in insertion order, and the engine yields in `occurred_at` order, so
    `(occurred_at, id)` is a clean forward cursor from row one — the same
    property the production backfill goes out of its way to preserve.

    ## Why `write_all` owns the loop instead of a `write`-per-event

    The obvious shape — open the COPY lazily on the first `write`, close it in
    `close()` — does not survive contact with psycopg. `cursor.copy(...)`
    returns a context manager whose `__enter__` hands back a different object;
    holding only that second object lets the first be garbage-collected, which
    closes its underlying generator and aborts the COPY. It fails on row one
    with `GeneratorExit`, and the traceback points at `write_row`, nowhere near
    the actual mistake.

    Keeping the whole stream inside one `with` block removes the hazard rather
    than working around it, and it is the honest shape anyway: a COPY *is* a
    single scoped operation, not a sequence of independent writes.
    """

    COLUMNS = (
        "occurred_at",
        "event_type",
        "listing_id",
        "claim_id",
        "actor_org_id",
        "payload",
        "schema_version",
    )

    def __init__(self, conn: Connection) -> None:
        self._conn = conn
        self.count = 0

    def write_all(self, events: Iterable[Event]) -> int:
        columns = ", ".join(self.COLUMNS)
        written = 0
        with (
            self._conn.cursor() as cursor,
            cursor.copy(f"copy public.events ({columns}) from stdin") as copy,
        ):
            for event in events:
                validate_event(event)
                copy.write_row(
                    (
                        event.occurred_at,
                        event.event_type,
                        event.listing_id,
                        event.claim_id,
                        event.actor_org_id,
                        Jsonb(event.payload),
                        event.schema_version,
                    )
                )
                written += 1
        self._conn.commit()
        self.count = written
        return written

    def write(self, event: Event) -> None:
        raise NotImplementedError(
            "PostgresSink writes a whole stream at once; use write_all (see the class docstring)"
        )

    def close(self) -> None:
        return None


def drain(events: Iterable[Event], sink: Sink) -> int:
    """Push every event through `sink` and return how many there were.

    A sink that can consume the whole stream in one scope (`PostgresSink`) gets
    to do so; the rest are fed one at a time.
    """
    write_all = getattr(sink, "write_all", None)
    if callable(write_all):
        count: int = write_all(events)
        return count

    written = 0
    for event in events:
        sink.write(event)
        written += 1
    return written
