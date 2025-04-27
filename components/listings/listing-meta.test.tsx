import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ContactLine, formatWindow } from "@/components/listings/listing-meta";
import { ListingStatusBadge } from "@/components/listings/listing-status-badge";

describe("formatWindow", () => {
  it("collapses the second date when both are the same day", () => {
    const text = formatWindow("2026-09-01T18:00:00", "2026-09-01T22:00:00");
    // "1 Sep, 06:00 PM – 10:00 PM" — one date, two times.
    expect(text.match(/Sep/g)).toHaveLength(1);
    expect(text).toContain("–");
  });

  it("spells out both dates when the window crosses midnight", () => {
    const text = formatWindow("2026-09-01T22:00:00", "2026-09-02T02:00:00");
    expect(text.match(/Sep/g)).toHaveLength(2);
  });
});

describe("ContactLine", () => {
  it("renders reachable email and phone links", () => {
    render(
      <ContactLine
        name="Lakeside Harvest Pantry"
        address="5700 S Lake Shore Dr"
        email="hello@example.invalid"
        phone="(312) 555-0102"
      />,
    );
    expect(
      screen.getByRole("link", { name: /hello@example.invalid/ }),
    ).toHaveAttribute("href", "mailto:hello@example.invalid");
    expect(screen.getByRole("link", { name: /555/ })).toHaveAttribute(
      "href",
      "tel:3125550102",
    );
  });

  it("omits contact rows that aren't set", () => {
    render(<ContactLine name="Anonymous Donor" />);
    expect(screen.getByText("Anonymous Donor")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("ListingStatusBadge", () => {
  const past = "2000-01-01T00:00:00Z";
  const future = "2999-01-01T00:00:00Z";

  it("shows Open inside the pickup window", () => {
    render(<ListingStatusBadge status="open" pickupEnd={future} />);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("shows Expired for an open listing past its window", () => {
    render(<ListingStatusBadge status="open" pickupEnd={past} />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("keeps Claimed even once the window has lapsed", () => {
    render(<ListingStatusBadge status="claimed" pickupEnd={past} />);
    expect(screen.getByText("Claimed")).toBeInTheDocument();
  });
});
