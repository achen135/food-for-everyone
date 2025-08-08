# The ml serving image: FastAPI + uvicorn over the committed Model A bundle.
#
# `python:3.12-slim` rather than alpine: psycopg's and LightGBM's binary wheels
# are manylinux, so alpine would fall back to building both from source and drag
# in a compiler and a Fortran toolchain.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# LightGBM's manylinux wheel links against OpenMP, which python:3.12-slim does
# not carry. Without this the image builds and then fails on `import lightgbm`
# at startup — the worst place to find out.
RUN apt-get update \
 && apt-get install --no-install-recommends -y libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency metadata first, so an edit to the source does not invalidate the
# layer that installed LightGBM and psycopg.
COPY pyproject.toml README.md ./
COPY src ./src
COPY sql ./sql

# Runtime dependencies only — no `[dev]`. Tests run on the host (`make test`)
# and in CI, and a serving image has no business carrying pytest and mypy.
RUN pip install --no-cache-dir .

# The trained bundle. Copied after the install so retraining the model does not
# rebuild the dependency layers, which is the common case while iterating.
#
# ML_MODEL_DIR is not optional here. The package is installed into
# site-packages, so `ml.model.artifact`'s source-tree-relative default resolves
# to a path that does not exist in the image — see that module's MODEL_DIR note.
COPY model ./model
ENV ML_MODEL_DIR=/app/model

# Not root. The process only needs to read its own code and reach Postgres.
RUN useradd --system --create-home --uid 10001 ffe \
 && chown -R ffe:ffe /app
USER ffe

EXPOSE 8000

# Uses the app's own readiness rather than a bare TCP check: startup replays the
# whole event log into a FeatureState, so the port is open and listening for
# several seconds before the service can actually answer. `/healthz` returns 503
# until it can, which is exactly the distinction a healthcheck should make.
#
# urllib rather than curl, which is not in the slim image and is not worth a
# layer. A non-2xx raises, which is the non-zero exit the healthcheck wants.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]

CMD ["uvicorn", "ml.serve.app:app", "--host", "0.0.0.0", "--port", "8000"]
