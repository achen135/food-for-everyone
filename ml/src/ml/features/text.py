"""Turning the two free-text payload fields into numbers.

`quantity` and `title` arrive as text because that is what production stores —
`create_listing` takes them straight from a donor's form. A pipeline that
wanted structured fields would have to change the product; this one parses,
which is the same thing M13's serving path will have to do on live listings.

**A caveat that belongs on any metric built from `food_category`.** On the
simulated corpus the titles come from a fixed table of four strings per
category, so these keyword rules recover the generator's own category almost
perfectly. On real donor-written titles they would be far noisier. The feature
is therefore *more* informative here than it would be in production — which
inflates any model that leans on it, and is exactly the kind of thing
`ml/docs/simulator.md` exists to disclose.
"""

from __future__ import annotations

import re
from typing import Final

__all__ = ["food_category", "parse_quantity_units"]

_LEADING_NUMBER = re.compile(r"^\s*(\d+(?:\.\d+)?)")

#: Checked in order; first match wins. Ordering matters where a title could
#: match two rules — "frozen vegetables" is frozen, not produce, because
#: storage requirements dominate what it is made of.
_CATEGORY_RULES: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("frozen", ("frozen", "freezer")),
    ("bakery", ("bread", "bakery", "pastry", "roll", "bun", "cake")),
    ("produce", ("produce", "vegetable", "fruit", "salad", "green", "seasonal")),
    ("dairy", ("milk", "yoghurt", "yogurt", "cheese", "butter", "dairy", "cream")),
    ("beverages", ("water", "juice", "drink", "soda", "coffee", "tea", "beverage")),
    ("prepared_meals", ("meal", "deli", "catering", "hot ", "entree", "sandwich", "prepared")),
    ("dry_goods", ("pantry", "rice", "pasta", "tinned", "canned", "dry goods", "staple")),
)


def parse_quantity_units(quantity: str | None) -> float | None:
    """The leading number of a quantity string; `None` if there isn't one.

    Deliberately does not try to normalise units. "12 trays" and "12 cases" are
    both 12 here, and the unit word is left on the floor — comparing a tray to a
    case would need a conversion table this subsystem has no basis for. What the
    number carries is *scale*, and scale is what makes a load hard to place.
    """
    if not quantity:
        return None
    match = _LEADING_NUMBER.match(quantity)
    if match is None:
        return None
    return float(match.group(1))


def food_category(title: str | None) -> str | None:
    """A coarse category from the listing title, by keyword.

    Returns `None` for an empty title and `"other"` for one that matches
    nothing, because those are different facts: no title at all versus a title
    the rules do not recognise.
    """
    if not title:
        return None
    lowered = title.lower()
    for category, keywords in _CATEGORY_RULES:
        for keyword in keywords:
            if keyword in lowered:
                return category
    return "other"
