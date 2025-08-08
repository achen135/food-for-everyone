"""Hashing a feature vector, so training and serving can be compared.

`predictions.features_hash` exists to catch **training/serving skew**: the
serving path and the batch pipeline computing different numbers for the same
listing at the same instant. That failure does not raise. It shows up as a model
that was excellent offline quietly making worse decisions in production, and it
is very hard to find after the fact unless something recorded what the score was
actually computed from.

So every served prediction stores a digest of its exact feature vector. Re-derive
the features for that listing at that instant, hash them, and a mismatch says
the two paths have diverged — with the listing and the instant to reproduce it.

## What is hashed

All of `FEATURE_NAMES`, in `spec.py` order, **including `food_category`** even
though Model A does not consume it. The digest describes what the *pipeline*
produced, not what one model happened to read; a later model that turns the
categorical back on should not change the meaning of a hash written today.

Values are encoded rather than `repr`'d wholesale, because the two sides reach
this function from different places — one from a live `FeatureState`, one from a
`features_waste` row round-tripped through Postgres — and the encoding has to
agree across that boundary:

- `None` is `null`, distinct from any value. A donor with no history and a donor
  with a zero rate are different facts and must not collide.
- `bool` is checked **before** `int`, because in Python `True` is an `int` and
  would otherwise encode as `1` — silently colliding with a genuine 1 in any
  column that could hold either.
- floats use `repr`, which round-trips a double exactly, so a value written to a
  `double precision` column and read back encodes identically.
"""

from __future__ import annotations

import hashlib
from typing import Any

from ml.features.spec import FEATURE_NAMES

__all__ = ["DIGEST_PREFIX", "encode_value", "features_hash"]

#: Names the algorithm in the stored string, so a future change to the encoding
#: is visible in the data rather than looking like universal skew.
DIGEST_PREFIX = "v1"

_SEPARATOR = "\x1f"


def encode_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return str(value)


def features_hash(features: dict[str, Any]) -> str:
    """`v1:<16 hex>` over the ordered feature vector.

    Raises on a missing feature rather than hashing a partial vector — a digest
    that quietly covered 24 of 25 values would agree with itself forever and
    detect nothing.
    """
    missing = [name for name in FEATURE_NAMES if name not in features]
    if missing:
        raise KeyError(f"cannot hash a partial feature vector; missing: {', '.join(missing)}")

    payload = _SEPARATOR.join(f"{name}={encode_value(features[name])}" for name in FEATURE_NAMES)
    digest = hashlib.blake2b(payload.encode("utf-8"), digest_size=8).hexdigest()
    return f"{DIGEST_PREFIX}:{digest}"
