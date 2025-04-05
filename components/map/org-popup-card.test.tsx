import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { OrgFeatureProperties } from "@/lib/geojson";
import { OrgPopupCard } from "@/components/map/org-popup-card";

const org: OrgFeatureProperties = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Lakeside Harvest Pantry",
  type: "recipient",
  description: "Neighbourhood pantry serving Hyde Park.",
  email: "hello@example.invalid",
  phone: "(312) 555-0102",
  website: "https://example.invalid",
  address: "5700 S Lake Shore Dr, Chicago",
  verified: true,
  distanceKm: 8.5,
};

describe("OrgPopupCard", () => {
  it("shows the organization's name, type, and distance", () => {
    render(<OrgPopupCard org={org} />);
    expect(screen.getByText("Lakeside Harvest Pantry")).toBeInTheDocument();
    expect(screen.getByText("recipient")).toBeInTheDocument();
    expect(screen.getByText("8.5 km away")).toBeInTheDocument();
  });

  it("renders contact details as actionable links", () => {
    render(<OrgPopupCard org={org} />);
    expect(screen.getByRole("link", { name: org.email! })).toHaveAttribute(
      "href",
      "mailto:hello@example.invalid",
    );
    // Punctuation is stripped so the tel: URI dials correctly.
    expect(screen.getByRole("link", { name: org.phone! })).toHaveAttribute(
      "href",
      "tel:3125550102",
    );
  });

  it("opens the website safely in a new tab", () => {
    render(<OrgPopupCard org={org} />);
    const link = screen.getByRole("link", { name: "example.invalid" });
    expect(link).toHaveAttribute("href", "https://example.invalid");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("badges a verified organization", () => {
    render(<OrgPopupCard org={org} />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("omits the verified badge when unverified", () => {
    render(<OrgPopupCard org={{ ...org, verified: false }} />);
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("skips missing optional fields instead of rendering empties", () => {
    render(
      <OrgPopupCard
        org={{ ...org, description: null, phone: null, website: null }}
      />,
    );
    expect(screen.queryByRole("link", { name: /555/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Neighbourhood pantry serving Hyde Park."),
    ).not.toBeInTheDocument();
    // The email link is still there.
    expect(screen.getByRole("link", { name: org.email! })).toBeInTheDocument();
  });
});
