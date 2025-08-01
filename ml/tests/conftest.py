"""Shared fixtures.

The simulator is a batch program, so most tests here run it and inspect the
output rather than poking at internals. That is deliberate: the contract these
tests defend is about the *stream*, and a test that reached into the engine
would keep passing through a refactor that broke the bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

REPO_ML = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class CliResult:
    stdout: bytes
    stderr: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.stdout).hexdigest()

    @property
    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.stdout.decode().splitlines()]

    @property
    def stats(self) -> dict[str, Any]:
        """The `--stats-json` summary, parsed from stderr."""
        parsed: dict[str, Any] = json.loads(self.stderr.strip().splitlines()[-1])
        return parsed


def run_cli(*args: str, hashseed: str = "0") -> CliResult:
    """Run `python -m ml.simulate` in a **fresh process**.

    In-process would be faster and would defeat the point. `PYTHONHASHSEED`
    only takes effect at interpreter start, so the determinism test can only
    catch a hash-order dependency — iterating a set of org ids, say — if each
    run really is a new interpreter with a different salt.
    """
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = hashseed
    proc = subprocess.run(
        [sys.executable, "-m", "ml.simulate", *args],
        cwd=REPO_ML,
        env=env,
        capture_output=True,
        check=True,
    )
    return CliResult(stdout=proc.stdout, stderr=proc.stderr.decode())


@pytest.fixture(scope="session")
def short_run() -> CliResult:
    """A small but structurally complete corpus: all five event types present.

    Two weeks at a tenth of the population. Small enough to run in a couple of
    seconds, long enough that withdrawals and re-claims both occur — a run too
    short to contain a `listing_cancelled` would let the contract test pass
    while never exercising the case with the `displaced_*` keys populated.
    """
    return run_cli(
        "--months",
        "1",
        "--donors",
        "70",
        "--recipients",
        "45",
        "--out",
        "jsonl",
        "--path",
        "-",
        "--stats-json",
    )


def requires_slow() -> pytest.MarkDecorator:
    return pytest.mark.skipif(
        os.environ.get("ML_RUN_SLOW") != "1",
        reason="full-scale run; set ML_RUN_SLOW=1 (CI does, via `make test-slow`)",
    )


def corpus_test_dsn() -> str:
    """A DSN for a throwaway database, created if absent.

    `tests/test_postgres.py` writes a small corpus to exercise the SQL
    bootstrap and the COPY path. It used to do that in the **real** corpus
    database, which replaced `public.events` with 3,370 rows and left
    `test_committed_numbers_match_a_recomputation` permanently skipping — the
    reproducibility check was present and never actually ran.

    So the integration tests get their own database, named after the corpus one
    with `_pytest` appended. Creating it needs autocommit (Postgres forbids
    CREATE DATABASE inside a transaction) and a connection to `postgres`, which
    both the compose container and the CI service container provide.
    """
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    from ml.db import resolve_dsn

    info = conninfo_to_dict(resolve_dsn())
    base = str(info.get("dbname") or "ffe_ml")
    target = f"{base}_pytest"

    # make_conninfo's signature is (conninfo, **kwargs); the dict values are
    # typed loosely by conninfo_to_dict, so pass them as kwargs off an
    # empty base string.
    admin = make_conninfo("", **{**info, "dbname": "postgres"})
    with psycopg.connect(admin, autocommit=True) as conn:
        exists = conn.execute("select 1 from pg_database where datname = %s", (target,)).fetchone()
        if exists is None:
            # The identifier is derived from our own DSN, not from input, but
            # quote it properly anyway rather than interpolating bare.
            conn.execute(
                psycopg.sql.SQL("create database {}").format(psycopg.sql.Identifier(target))
            )

    return make_conninfo("", **{**info, "dbname": target})
