"""`python -m ml.db_reset` — re-apply `ml/sql/` after editing it.

A module rather than a `python -c` one-liner in the Makefile. The one-liner it
replaces was `connect().__enter__()`, which is the same lifetime bug the COPY
sink hit: the context manager is a temporary, so it is garbage-collected the
moment the expression ends and takes the connection with it. The failure —
"the connection is closed" — arrives on the *next* statement, pointing away
from the cause.
"""

from __future__ import annotations

import sys

from ml.db import bootstrap, connect


def main() -> int:
    with connect() as conn:
        applied = bootstrap(conn)
    print("applied: " + ", ".join(applied), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
