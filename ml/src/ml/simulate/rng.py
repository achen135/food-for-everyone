"""Determinism plumbing.

"Same seed → byte-identical event stream" is a testable claim, and it is easy
to break by accident. Three rules hold it up, and all three live here:

1. **Named substreams.** Every draw comes from a stream derived from
   ``(seed, name)`` via BLAKE2b, so adding a draw to org generation cannot
   shift the numbers the behavioural loop sees. A single shared generator would
   make every tuning change a whole-corpus reshuffle, and a determinism test
   that fails on every edit gets deleted.

2. **No `hash()`, ever.** Python salts string hashing per process
   (``PYTHONHASHSEED``), so anything derived from ``hash("donor")`` differs
   between runs. BLAKE2b is stable across processes, platforms and versions.

3. **No iteration over sets.** Set iteration order follows string hashes, which
   are salted, so a loop over a set of org ids is a per-process reshuffle
   wearing a disguise. The simulator uses sorted lists and dicts throughout;
   this is the rule most easily broken by a later edit, which is why the
   determinism test runs the CLI in a **fresh subprocess** rather than calling
   into it, so a salt difference has somewhere to show up.

`random.Random` (Mersenne Twister) rather than `numpy.random.Generator`:
CPython guarantees the stream for a given seed across versions, and the
generative path needs no array maths.
"""

from __future__ import annotations

import hashlib
import random
from uuid import UUID

__all__ = ["new_uuid", "substream", "weighted_choice"]


def substream(seed: int, name: str) -> random.Random:
    """An independent generator for `name`, reproducible from `seed` alone."""
    digest = hashlib.blake2b(f"{seed}::{name}".encode(), digest_size=32).digest()
    return random.Random(int.from_bytes(digest, "big"))


def new_uuid(rng: random.Random) -> UUID:
    """A version-4 UUID drawn from `rng` rather than from the OS entropy pool.

    `uuid.uuid4()` would be non-reproducible, and these ids end up in the event
    stream whose bytes the determinism test hashes.
    """
    return UUID(bytes=rng.randbytes(16), version=4)


def weighted_choice(rng: random.Random, items: list[tuple[str, float]]) -> str:
    """Pick from `(value, weight)` pairs, consuming exactly one draw.

    `items` is a list, not a dict or a set, because the caller's iteration order
    is part of the seed→output mapping.
    """
    total = 0.0
    for _, weight in items:
        total += weight
    target = rng.random() * total
    upto = 0.0
    for value, weight in items:
        upto += weight
        if target < upto:
            return value
    return items[-1][0]
