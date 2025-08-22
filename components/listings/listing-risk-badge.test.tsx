import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ListingRiskBadge } from "@/components/listings/listing-risk-badge";

/**
 * The ML escalation badge (M14).
 *
 * The behaviour worth defending is what happens when there is *nothing* to
 * show: flag off, batch job never run, listing not currently open. All three
 * reach this component as `undefined`, and all three must render exactly as the
 * page did before M14 — nothing at all, not an empty box or a placeholder.
 */
describe("ListingRiskBadge", () => {
  it("renders the escalation for a high-risk listing", () => {
    render(<ListingRiskBadge tier="high" />);
    expect(screen.getByText(/unlikely to be collected/i)).toBeInTheDocument();
  });

  it("renders nothing when there is no risk row", () => {
    const { container } = render(<ListingRiskBadge tier={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["low", "medium"] as const)(
    "renders nothing for the %s tier",
    (tier) => {
      const { container } = render(<ListingRiskBadge tier={tier} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("does not put a raw probability in front of the user", () => {
    render(<ListingRiskBadge tier="high" />);
    // The model is trained on simulated data; a number here would imply a
    // precision the model card explicitly disclaims.
    expect(
      screen.getByText(/unlikely to be collected/i).textContent,
    ).not.toMatch(/\d/);
  });

  it("explains what the flag is based on, and that it is an estimate", () => {
    render(<ListingRiskBadge tier="high" />);
    const badge = screen.getByTitle(/model estimate, not a certainty/i);
    expect(badge).toBeInTheDocument();
  });

  it("does not rely on colour alone to carry its meaning", () => {
    // The icon is decorative (aria-hidden); the text is what conveys the state.
    render(<ListingRiskBadge tier="high" />);
    expect(screen.getByText(/unlikely to be collected/i)).toBeVisible();
  });
});
