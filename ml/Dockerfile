# ml subsystem image.
#
# Minimal on purpose: M11 needs a Python with the package installed and a
# Postgres driver. M13 fleshes this out into the FastAPI serving image
# (uvicorn, a non-root user, a healthcheck, the trained model artefact).
#
# `python:3.12-slim` rather than alpine: psycopg's binary wheels are manylinux,
# so alpine would fall back to building from source and drag in a compiler.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependency metadata first, so an edit to the source does not invalidate the
# layer that installed psycopg.
COPY pyproject.toml README.md ./
COPY src ./src
COPY sql ./sql

RUN pip install --no-cache-dir -e ".[dev]"

CMD ["python", "-m", "ml.simulate", "--help"]
