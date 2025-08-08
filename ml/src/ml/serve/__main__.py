"""`python -m ml.serve` — run the scoring API.

A thin uvicorn launcher so the service can be started the same way as every
other entry point in `ml/`. The container runs `uvicorn ml.serve.app:app`
directly; this exists for local use.
"""

from __future__ import annotations

import argparse

import uvicorn


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ml.serve", description="Run the waste-risk scoring API."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    uvicorn.run("ml.serve.app:app", host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
