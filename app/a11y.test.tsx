import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";

import Home from "@/app/page";
import { ListingForm } from "@/components/listings/listing-form";
import { OrganizationForm } from "@/components/organization/organization-form";
import { SignInForm } from "@/components/auth/sign-in-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/(auth)/actions", () => ({ signIn: vi.fn() }));
vi.mock("@/app/app/listings/actions", () => ({ createListingAction: vi.fn() }));
vi.mock("@/app/app/organization/actions", () => ({
  saveOrganizationAction: vi.fn(),
  searchAddressAction: vi.fn(),
}));

/**
 * Automated accessibility checks (Spec §7 M4 "a11y pass", Spec §10's
 * axe-core-in-CI item). These run in the normal Vitest suite, so CI enforces
 * them on every push rather than them being a one-off audit.
 *
 * What this does and doesn't buy: axe catches the mechanical failures — an
 * input with no label, a control with no accessible name, insufficient
 * contrast between declared colours, a broken heading order. It cannot judge
 * whether the page makes sense to navigate by keyboard or sounds right read
 * aloud. It is a floor, not a substitute for the manual pass.
 *
 * Colour-contrast is disabled here: axe computes contrast from resolved
 * styles, and jsdom does not apply the stylesheet, so every rule would resolve
 * against transparent and report noise. The palette's AA compliance is a
 * design-token property (Spec §8), checked when the ramp was chosen.
 */
const AXE_OPTIONS = { rules: { "color-contrast": { enabled: false } } };

async function expectNoViolations(ui: React.ReactElement) {
  const { container } = render(ui);
  const results = await axe(container, AXE_OPTIONS);
  const violations = results.violations ?? [];
  // Surface what actually failed rather than just a count.
  expect(
    violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`),
  ).toEqual([]);
}

describe("accessibility", () => {
  it("landing page has no axe violations", async () => {
    await expectNoViolations(<Home />);
  });

  it("sign-in form has no axe violations", async () => {
    await expectNoViolations(<SignInForm />);
  });

  it("organization form has no axe violations", async () => {
    await expectNoViolations(<OrganizationForm initial={null} />);
  });

  it("listing form has no axe violations", async () => {
    await expectNoViolations(<ListingForm />);
  });
});
