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

  /*
   * M9 rebuilt the illustration because two of its shapes were unreadable — a
   * viewBox-clipped wedge for a park, a floating blob for water. The drawing
   * itself can only be judged by looking at it, but the label is the part a
   * screen-reader user gets *instead* of looking, so it must keep describing
   * what is actually on the canvas.
   */
  it("describes the illustration by what it now draws", () => {
    render(<Home />);

    const illustration = screen.getByRole("img", { name: /city map/i });
    const label = illustration.getAttribute("aria-label") ?? "";

    for (const feature of [
      /river/i,
      /bridge/i,
      /park/i,
      /donor/i,
      /recipient/i,
    ]) {
      expect(label).toMatch(feature);
    }
  });
});
