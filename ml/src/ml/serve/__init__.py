"""The scoring service.

`sources` supplies events, `state` replays them into a `FeatureState` and scores
against the committed model, `schemas` is the wire contract, and `app` is the
FastAPI application. `python -m ml.serve` runs it.
"""
