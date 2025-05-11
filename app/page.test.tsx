import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

describe("Home (landing page)", () => {
  it("renders the hero heading and register CTA", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /good food finds a home/i,
      }),
    ).toBeInTheDocument();

    const registerLinks = screen.getAllByRole("link", {
      name: /register your organization/i,
    });
    expect(registerLinks.length).toBeGreaterThan(0);
    for (const link of registerLinks) {
      expect(link).toHaveAttribute("href", "/sign-up");
    }
  });

  it("links to the live demo, not a dead #", () => {
    render(<Home />);
    const demoLinks = screen.getAllByRole("link", { name: /live demo/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) {
      expect(link).toHaveAttribute("href", "/sign-in?demo=1");
    }
  });

  it("every nav anchor resolves to a section that exists on the page", () => {
    render(<Home />);
    for (const id of ["how-it-works", "for-donors", "for-food-banks"]) {
      const links = screen.getAllByRole("link").filter((el) => {
        const href = el.getAttribute("href");
        return href === `#${id}`;
      });
      expect(links.length).toBeGreaterThan(0);
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
