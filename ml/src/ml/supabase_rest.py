"""The one place the ml subsystem talks to FFE's production Supabase.

## Why this module exists at all, and why it is not `ml.db`

`ml/src/ml/db.py` **refuses a Supabase DSN on purpose** (`assert_not_supabase`),
and M14 does not loosen that guard — it adds a second, narrower door beside it.
The two are deliberate mirror images:

| | `ml.db` | this module |
|---|---|---|
| target | the local corpus Postgres | FFE production, only |
| refuses | anything that looks like Supabase | non-HTTP URLs, and any host that
  is neither a Supabase project nor local Supabase |
| writes | freely (the corpus is regenerated) | `listing_risk` and nothing else |

`assert_is_supabase` is the mirror of `assert_not_supabase`. Together they mean
a mis-set environment variable cannot cross the streams in either direction: a
corpus DSN handed to this client is refused, and a Supabase URL handed to
`ml.db` is refused. Neither guard has an override.

## Why HTTP rather than a Postgres connection

There is no Supabase Postgres password on this machine — `.env.local` carries
the project URL, the anon key and the service-role key, and that is all. The
service-role key authenticates against PostgREST, so that is the transport.

It turns out to be the better fit anyway. PostgREST is **table-scoped by
path**: a client that only ever builds `/rest/v1/events` and
`/rest/v1/listing_risk` URLs cannot touch `organizations` or `auth.users` by
accident, whereas a Postgres connection with the service role is unrestricted.
The narrowness the M14 brief asks for ("this is the one ml→Supabase *write*
path in the whole subsystem; keep it that narrow") is expressed in the type
system here rather than in a comment.

## Stdlib only

`urllib.request` rather than `httpx` or `requests`. `httpx` is a **dev**
dependency (Starlette's TestClient), and the batch job runs in GitHub Actions
where every added runtime dependency is install time on a schedule. Two JSON
verbs against one host do not justify a package — see the `pyproject.toml`
header on keeping the dependency list short.

## The service-role key bypasses RLS

Everything below runs as `service_role`, which is not subject to row-level
security. That is required for the `listing_risk` write (the table has no
insert policy, on purpose — see the M14 migration), and it is why the read
side is a separate object that physically cannot write.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Any

__all__ = [
    "NotSupabaseError",
    "ReadOnlyClientError",
    "SupabaseConfig",
    "SupabaseError",
    "SupabaseRest",
    "assert_is_supabase",
    "resolve_supabase",
]

#: PostgREST's own default page size. Asking for more in one request is capped
#: server-side, so the page loop below uses this as the stride rather than
#: hoping a larger `limit` is honoured.
PAGE_SIZE = 1000

DEFAULT_TIMEOUT = 30.0


class SupabaseError(RuntimeError):
    """A non-2xx response from PostgREST, with the body attached."""


class NotSupabaseError(RuntimeError):
    """The configured URL does not look like a Supabase project."""


class ReadOnlyClientError(RuntimeError):
    """A write was attempted through a client constructed read-only."""


def assert_is_supabase(url: str) -> None:
    """Refuse a URL that is not a Supabase/PostgREST endpoint.

    The mirror of `ml.db.assert_not_supabase`, and it exists for the same class
    of mistake pointed the other way. `ml.db` protects production from the
    corpus generator; this protects the corpus from a job that thinks it is
    talking to production.

    ## What passes

    - a hosted project: `https://<ref>.supabase.co`
    - **local Supabase**: `http://127.0.0.1:54321` (or `localhost`)

    Local is allowed deliberately, and it is not a hole. The thing this guard
    exists to catch is the *corpus database* — which is reached by a
    `postgresql://…:55432/ffe_ml` DSN, not an HTTP URL, and is refused below on
    the scheme alone before the host is even considered. Allowing local Supabase
    is what makes it possible to rehearse the production write path end to end
    against a throwaway database before pointing it at the real project, which
    is the difference between a dry run and a hope.

    ## What does not

    Anything that is not http/https (so every Postgres DSN), and any other host
    — a random API, a typo'd domain, a staging service that happens to speak
    JSON. The write path this guards is the only one in the subsystem allowed to
    modify FFE, so it says yes to two shapes and no to everything else.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise NotSupabaseError(
            f"refusing {url!r} as the FFE endpoint: expected an http(s) URL, got scheme "
            f"{parsed.scheme!r}. This client speaks PostgREST over HTTP; the corpus "
            "Postgres is reached through ml.db instead."
        )

    host = (parsed.hostname or "").lower()
    hosted = host.endswith((".supabase.co", ".supabase.com"))
    local = host in ("localhost", "127.0.0.1", "::1")
    if not (hosted or local):
        raise NotSupabaseError(
            f"refusing to use {url!r} as the FFE production endpoint: {host!r} does not look "
            "like a Supabase project or a local Supabase stack. This client only ever talks "
            "to FFE; the corpus is reached through ml.db instead."
        )


class SupabaseConfig:
    """Project URL + service-role key, resolved and validated once."""

    __slots__ = ("key", "url")

    def __init__(self, url: str, key: str) -> None:
        cleaned = url.rstrip("/")
        assert_is_supabase(cleaned)
        self.url = cleaned
        self.key = key

    @property
    def rest_root(self) -> str:
        return f"{self.url}/rest/v1"


def resolve_supabase(url: str | None = None, key: str | None = None) -> SupabaseConfig:
    """Read the production endpoint from the environment.

    `FFE_*` is checked before the app's own names so a scheduled job can be
    pointed at a different project without touching `.env.local`, which the web
    app and the seed script both read. In practice CI sets the `FFE_*` pair from
    repository secrets and a local run inherits the `.env.local` names.
    """
    resolved_url = (
        url or os.environ.get("FFE_SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    )
    resolved_key = (
        key
        or os.environ.get("FFE_SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    if not resolved_url:
        raise NotSupabaseError(
            "no production endpoint configured; set FFE_SUPABASE_URL "
            "(or NEXT_PUBLIC_SUPABASE_URL) to the project URL"
        )
    if not resolved_key:
        raise NotSupabaseError(
            "no service-role key configured; set FFE_SUPABASE_SERVICE_ROLE_KEY "
            "(or SUPABASE_SERVICE_ROLE_KEY). The anon key cannot write listing_risk."
        )
    return SupabaseConfig(resolved_url, resolved_key)


class SupabaseRest:
    """A thin PostgREST client, optionally refusing every write verb.

    `read_only=True` is not a courtesy flag — `ProductionEventReader` is built
    with it so that the code path which replays production events has no
    reachable way to modify production, whatever a future edit does to it. The
    write path is a separate object in `ml.batch.writeback` naming exactly one
    table.
    """

    __slots__ = ("_config", "_read_only", "_timeout")

    def __init__(
        self,
        config: SupabaseConfig | None = None,
        *,
        read_only: bool = False,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._config = config if config is not None else resolve_supabase()
        self._read_only = read_only
        self._timeout = timeout

    @property
    def project_url(self) -> str:
        return self._config.url

    # -- transport ----------------------------------------------------------

    def _request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        body: Any = None,
        prefer: str | None = None,
    ) -> tuple[Any, dict[str, str]]:
        if method != "GET" and self._read_only:
            raise ReadOnlyClientError(
                f"this client is read-only; refusing {method} on {table!r}. "
                "The production write path is ml.batch.writeback.ListingRiskWriter."
            )

        url = f"{self._config.rest_root}/{table}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"

        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=payload, method=method)
        request.add_header("apikey", self._config.key)
        request.add_header("Authorization", f"Bearer {self._config.key}")
        request.add_header("Accept", "application/json")
        if payload is not None:
            request.add_header("Content-Type", "application/json")
        if prefer:
            request.add_header("Prefer", prefer)

        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
                headers = {k.lower(): v for k, v in response.headers.items()}
        except urllib.error.HTTPError as error:  # pragma: no cover - network failure path
            detail = error.read().decode("utf-8", "replace")[:500]
            raise SupabaseError(
                f"{method} {table} failed with HTTP {error.code}: {detail}"
            ) from error
        except urllib.error.URLError as error:  # pragma: no cover - network failure path
            raise SupabaseError(f"{method} {table} could not reach {self._config.url}") from error

        if not raw:
            return None, headers
        return json.loads(raw), headers

    # -- verbs --------------------------------------------------------------

    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        order: str | None = None,
        filters: dict[str, str] | None = None,
        page_size: int = PAGE_SIZE,
    ) -> Iterator[dict[str, Any]]:
        """Every matching row, paged.

        PostgREST caps a response at its configured maximum (1000 by default),
        and it does so **silently** — a table with 1500 rows answers an
        unpaged request with 1000 and no indication that it truncated. Reading
        the event log one page short would not raise; it would quietly produce
        a `FeatureState` missing recent history and therefore plausible wrong
        scores. That is the same class of failure `features_hash` exists to
        catch, so the loop below always pages and only stops on a short page.

        `order` must be a total order for paging to be sound — `offset` is
        meaningless against an unstable sort. Callers here pass
        `occurred_at.asc,id.asc`, where `id` is the identity primary key.
        """
        offset = 0
        while True:
            params: dict[str, str] = {
                "select": columns,
                "limit": str(page_size),
                "offset": str(offset),
            }
            if order:
                params["order"] = order
            if filters:
                params.update(filters)

            rows, _ = self._request("GET", table, params=params)
            if not rows:
                return
            yield from rows
            if len(rows) < page_size:
                return
            offset += len(rows)

    def first(
        self,
        table: str,
        *,
        columns: str = "*",
        order: str | None = None,
        filters: dict[str, str] | None = None,
    ) -> dict[str, Any] | None:
        """The single first row under `order`, or `None`.

        A separate method rather than `select(..., page_size=1)`: `select`
        pages until it sees a short page, so a page size of one would walk the
        entire table one row at a time. Asking for a maximum is a different
        operation from asking for everything, so it gets a different name.
        """
        params: dict[str, str] = {"select": columns, "limit": "1"}
        if order:
            params["order"] = order
        if filters:
            params.update(filters)
        rows, _ = self._request("GET", table, params=params)
        if not rows:
            return None
        row: dict[str, Any] = rows[0]
        return row

    def upsert(self, table: str, rows: list[dict[str, Any]], *, on_conflict: str) -> None:
        """`insert ... on conflict (<on_conflict>) do update`, in one request."""
        if not rows:
            return
        self._request(
            "POST",
            table,
            params={"on_conflict": on_conflict},
            body=rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def delete(self, table: str, *, filters: dict[str, str]) -> None:
        """Delete matching rows.

        `filters` is required and must be non-empty: PostgREST happily deletes
        an entire table given no filter, and an accidental unfiltered DELETE
        against production is not a mistake worth leaving reachable.
        """
        if not filters:
            raise ValueError("refusing an unfiltered delete against production")
        self._request("DELETE", table, params=filters, prefer="return=minimal")

    def count(self, table: str, *, filters: dict[str, str] | None = None) -> int:
        params: dict[str, str] = {"select": "count"}
        if filters:
            params.update(filters)
        rows, _ = self._request("GET", table, params=params)
        if not rows:
            return 0
        return int(rows[0]["count"])
