"""Writing `features_waste`, and reading it back for evaluation."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from datetime import datetime
from typing import Any, cast

import numpy as np
import psycopg

from ml.features.spec import ALL_COLUMNS, FEATURE_NAMES

__all__ = ["FeatureMatrix", "load_matrix", "truncate_features", "write_features"]


def truncate_features(conn: psycopg.Connection) -> None:
    conn.execute("truncate table public.features_waste")
    conn.commit()


def write_features(
    conn: psycopg.Connection,
    rows: Iterable[tuple[str, datetime, dict[str, Any], int, str]],
) -> int:
    """COPY labelled observations into `features_waste`.

    Rows arrive as `(listing_id, as_of, features, label, split)`; the feature
    dict is flattened in `FEATURE_NAMES` order so a mismatch between the dict
    and the table surfaces here rather than as a silently shifted column.
    """
    columns = ", ".join(ALL_COLUMNS)
    written = 0
    with (
        conn.cursor() as cursor,
        cursor.copy(f"copy public.features_waste ({columns}) from stdin") as copy,
    ):
        for listing_id, as_of, features, label, split in rows:
            copy.write_row(
                (listing_id, as_of, *(features[name] for name in FEATURE_NAMES), label, split)
            )
            written += 1
    conn.commit()
    return written


class FeatureMatrix:
    """Feature values, labels and splits for one evaluation run.

    Held as parallel numpy arrays rather than a dataframe: the eval harness only
    ever needs column access by name, pandas would be a dependency earned by
    nothing, and keeping labels as a plain array makes it obvious that no
    transformation is quietly happening between load and metric.
    """

    def __init__(
        self,
        columns: dict[str, np.ndarray],
        label: np.ndarray,
        split: np.ndarray,
        listing_id: np.ndarray,
        as_of: np.ndarray,
    ) -> None:
        self.columns = columns
        self.label = label
        self.split = split
        self.listing_id = listing_id
        #: Observation time as epoch seconds. Float rather than datetime64 so
        #: comparisons are plain arithmetic and no timezone can be lost on the
        #: way in; `ml.model.dataset` turns it back into an aware datetime for
        #: reporting. M13 needs it to sub-divide `val` by time.
        self.as_of = as_of

    def __len__(self) -> int:
        return int(self.label.shape[0])

    def mask(self, split: str) -> np.ndarray:
        return cast(np.ndarray, self.split == split)

    def column(self, name: str, split: str | None = None) -> np.ndarray:
        values = self.columns[name]
        return values if split is None else cast(np.ndarray, values[self.mask(split)])

    def labels(self, split: str | None = None) -> np.ndarray:
        return self.label if split is None else cast(np.ndarray, self.label[self.mask(split)])

    def times(self, split: str | None = None) -> np.ndarray:
        return self.as_of if split is None else cast(np.ndarray, self.as_of[self.mask(split)])


def _iter_rows(conn: psycopg.Connection, names: list[str]) -> Iterator[tuple[Any, ...]]:
    selected = ", ".join(["listing_id", "as_of", "label", "split", *names])
    with conn.cursor(name="features_scan") as cursor:
        cursor.itersize = 50_000
        cursor.execute(f"select {selected} from public.features_waste order by as_of, listing_id")
        yield from cursor


def load_matrix(conn: psycopg.Connection, names: list[str] | None = None) -> FeatureMatrix:
    """Read `features_waste` into memory, ordered by `as_of`.

    Numeric columns only by default. `food_category` is the one text feature and
    is excluded here: M12 evaluates rules baselines, none of which use it, and
    encoding a categorical is M13's business.
    """
    if names is None:
        names = [name for name in FEATURE_NAMES if name != "food_category"]

    listing_ids: list[str] = []
    times: list[float] = []
    labels: list[int] = []
    splits: list[str] = []
    values: list[list[float]] = [[] for _ in names]

    for row in _iter_rows(conn, names):
        listing_ids.append(str(row[0]))
        times.append(row[1].timestamp())
        labels.append(int(row[2]))
        splits.append(str(row[3]))
        for position, raw in enumerate(row[4:]):
            # NULL means "not known" (a donor with no history yet), which numpy
            # carries as NaN. Rules baselines that touch a nullable column say
            # explicitly what they do with it.
            values[position].append(float("nan") if raw is None else float(raw))

    return FeatureMatrix(
        columns={
            name: np.asarray(column, dtype=np.float64)
            for name, column in zip(names, values, strict=True)
        },
        label=np.asarray(labels, dtype=np.int8),
        split=np.asarray(splits, dtype=object),
        listing_id=np.asarray(listing_ids, dtype=object),
        as_of=np.asarray(times, dtype=np.float64),
    )
