"""The FastAPI application.

Thin by design. Every judgement call lives one layer down — `scoring.py` decides
what a score is and when the state can answer, `schemas.py` decides what the
contract is, `sources.py` decides where events come from. This file maps those
onto HTTP and onto the right status codes, and does the timing.

## The status codes are part of the contract

- **404** — no such listing at or before the replay cursor. It may exist in the
  product and simply not be in the log the service replayed.
- **409** — the listing exists but is not *open* at `as_of`. Every training row
  came from an open listing before its `pickup_end`, so a claimed or expired one
  is a question the model was never asked; it would answer confidently anyway.
- **422** — `as_of` precedes the cursor. Not a malformed request in the usual
  sense: it is well-formed and unanswerable, because the state has already seen
  past that instant and any answer would contain the future. Handing back a 500
  would make a correctness guard look like a crash.
- **503** — the service has not finished warming. Startup replays the whole
  corpus, so there is a real window where the process is listening and cannot
  answer yet.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Response

from ml.serve.metrics import Metrics
from ml.serve.schemas import HealthResponse, ScoreRequest, ScoreResponse
from ml.serve.scoring import (
    ListingNotOpenError,
    ScoringService,
    StaleAsOfError,
    UnknownListingError,
)

__all__ = ["app", "create_app"]


def create_app(service: ScoringService | None = None, *, warm: bool = True) -> FastAPI:
    """Build the app. Tests pass a pre-built service and skip the replay."""
    metrics = Metrics()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if warm and not application.state.service.ready:
            application.state.service.warm()
        yield
        application.state.service.close()

    application = FastAPI(
        title="Food For Everyone — waste-risk scoring",
        version="1.0.0",
        summary=(
            "Scores an OPEN donation listing for the probability it expires unclaimed. "
            "Trained on SIMULATED data (ml/docs/simulator.md)."
        ),
        lifespan=lifespan,
    )
    application.state.service = service if service is not None else ScoringService()
    application.state.metrics = metrics

    @application.post("/score/waste", response_model=ScoreResponse)
    def score_waste(request: ScoreRequest) -> ScoreResponse:
        service_ = application.state.service
        if not service_.ready:
            metrics.observe_request("/score/waste", 503)
            raise HTTPException(status_code=503, detail="the service is still warming up")

        started = time.perf_counter()
        try:
            result = service_.score(str(request.listing_id), request.as_of)
        except UnknownListingError:
            metrics.observe_request("/score/waste", 404)
            raise HTTPException(
                status_code=404,
                detail=(
                    f"listing {request.listing_id} is not in the log this service "
                    "replayed at or before its cursor"
                ),
            ) from None
        except ListingNotOpenError as error:
            metrics.observe_request("/score/waste", 409)
            raise HTTPException(status_code=409, detail=str(error)) from None
        except StaleAsOfError as error:
            metrics.observe_request("/score/waste", 422)
            raise HTTPException(status_code=422, detail=str(error)) from None

        metrics.observe_score(time.perf_counter() - started)
        metrics.observe_request("/score/waste", 200)
        return ScoreResponse(
            listing_id=request.listing_id,
            as_of=result.as_of,
            score=result.score,
            risk_tier=result.risk_tier,
            model_version=result.model_version,
            features_hash=result.features_hash,
        )

    @application.get("/healthz", response_model=HealthResponse)
    def healthz(response: Response) -> HealthResponse:
        report = application.state.service.health()
        # A degraded service still answers with a body describing why. Returning
        # 503 as well is what makes it usable as a container healthcheck.
        status = 200 if report["status"] == "ok" else 503
        response.status_code = status
        metrics.observe_request("/healthz", status)
        return HealthResponse(**report)

    @application.get("/metrics")
    def metrics_endpoint() -> Response:
        metrics.observe_request("/metrics", 200)
        return Response(
            content=metrics.render(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    return application


#: The ASGI target: `uvicorn ml.serve.app:app`. Built lazily by the module-level
#: call so that importing this module in a test does not replay a corpus.
app = create_app()
