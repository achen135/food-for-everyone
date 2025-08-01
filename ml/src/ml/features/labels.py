"""Deriving the label, and the compact index that makes it a two-pass job.

The label needs the future; the features must not have it. Keeping them in
separate structures is how that stays true — `LabelIndex` is built by its own
scan and is never visible to `pipeline.py`.

## What is kept, and why so little

Only four things per listing: when it was posted, when its window closes, when
it was claimed, and when it was withdrawn while unclaimed. That is everything
the label and the split need, and holding it costs a few tens of megabytes for a
300k-event corpus where retaining the events themselves would cost most of a
gigabyte. It is also why the pipeline can stay a stream: the expensive pass
never has to hold the log.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime

from ml.features.log import LogEvent

__all__ = ["LabelIndex", "LabelOutcome", "ListingFacts", "build_label_index"]


class LabelOutcome:
    """Why an observation got the label it got — or why it has none."""

    WASTED = "wasted"
    CLAIMED = "claimed"
    WITHDRAWN = "withdrawn"
    CENSORED = "censored"


@dataclass(slots=True)
class ListingFacts:
    posted_at: datetime
    pickup_end: datetime
    claim_times: list[datetime] = field(default_factory=list)
    withdrawn_unclaimed_times: list[datetime] = field(default_factory=list)


@dataclass(slots=True)
class LabelIndex:
    listings: dict[str, ListingFacts]
    corpus_start: datetime
    corpus_end: datetime

    def label(self, listing_id: str, as_of: datetime) -> tuple[int | None, str]:
        """The label for one open-listing observation, and the reason.

        `(None, reason)` means the observation must be dropped.

        ## The definition

            1  no claim after `as_of`, not withdrawn-while-unclaimed after
               `as_of`, and `pickup_end` falls inside the corpus
            0  a claim happens after `as_of`
            -  withdrawn while unclaimed after `as_of`: dropped
            -  `pickup_end` past the end of the corpus: right-censored, dropped

        ## Where this refines the brief, on purpose

        The brief states the label per *listing*, evaluated once its window has
        closed: `listing_posted` ∧ `pickup_end < as_of` ∧ no `listing_claimed`
        ∧ not `listing_cancelled` while unclaimed. For the overwhelmingly common
        case — a listing never claimed at all — this agrees with it exactly.

        It differs on one case. `release_claim` puts a claimed listing **back on
        offer**, so `open → claimed → open → expired` is a real path. Under a
        per-listing rule that listing has a `listing_claimed` event, so *every*
        observation of it is labelled 0 — including the ones taken after the
        release, when the listing is open again and heading for expiry. Those
        are exactly the observations the model exists to flag, and the
        per-listing rule labels them backwards.

        Per-observation and forward-looking is also literally the question asked
        at serving time: *this listing is open now; will it expire unclaimed?*

        **Withdrawn is not wasted.** A donor who pulls an unclaimed offer — sold
        it, posted it twice — did not waste food. Counting them as positives
        would bake false positives into the training labels with nothing in the
        log to contradict them. That is the whole reason M10 emitted a fifth
        event type its own brief did not ask for, and this branch is the payoff.
        """
        facts = self.listings[listing_id]

        for claimed_at in facts.claim_times:
            if claimed_at > as_of:
                return 0, LabelOutcome.CLAIMED

        for withdrawn_at in facts.withdrawn_unclaimed_times:
            if withdrawn_at > as_of:
                return None, LabelOutcome.WITHDRAWN

        if facts.pickup_end > self.corpus_end:
            return None, LabelOutcome.CENSORED

        return 1, LabelOutcome.WASTED


def build_label_index(events: Iterable[LogEvent]) -> LabelIndex:
    """One scan of the log, keeping only what the label and the split need."""
    listings: dict[str, ListingFacts] = {}
    corpus_start: datetime | None = None
    corpus_end: datetime | None = None

    for event in events:
        if corpus_start is None:
            corpus_start = event.occurred_at
        corpus_end = event.occurred_at

        if event.event_type == "listing_posted":
            pickup_end = event.instant("pickup_end")
            assert pickup_end is not None
            listings[event.listing_id] = ListingFacts(
                posted_at=event.occurred_at, pickup_end=pickup_end
            )
        elif event.event_type == "listing_claimed":
            facts = listings.get(event.listing_id)
            if facts is not None:
                facts.claim_times.append(event.occurred_at)
        elif event.event_type == "listing_cancelled":
            facts = listings.get(event.listing_id)
            # `displaced_claim_id is None` is exactly "nobody was holding it".
            # A withdrawal that displaced a claim is a different situation, and
            # the observations before it already carry label 0 from that claim.
            if facts is not None and event.payload.get("displaced_claim_id") is None:
                facts.withdrawn_unclaimed_times.append(event.occurred_at)

    if corpus_start is None or corpus_end is None:
        raise ValueError("the event log is empty")

    return LabelIndex(listings=listings, corpus_start=corpus_start, corpus_end=corpus_end)
