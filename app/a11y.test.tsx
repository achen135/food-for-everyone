import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";

import Home from "@/app/page";
import { ListingForm } from "@/components/listings/listing-form";
import { OrganizationForm } from "@/components/organization/organization-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { ActivityChart } from "@/components/analytics/activity-chart";
import { FulfilmentMeter } from "@/components/analytics/fulfilment-meter";
import { ReachChart } from "@/components/analytics/reach-chart";
import { HeroStat, StatTile } from "@/components/analytics/stat-tile";
import { NETWORK_LABELS } from "@/lib/analytics";

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

  /*
   * The M8 dashboard adds the shapes axe is actually good at judging: a
   * `role="meter"` that needs its value attributes, a `<details>` disclosure, a
   * data table that needs real header cells, and `<dt>`/`<dd>` pairs that are
   * only valid inside a `<dl>`. Colour is the one thing these checks cannot
   * cover here (see the note above) — that was handled separately, by running
   * the palette through a contrast and colour-vision validator.
   */
  it("activity chart has no axe violations", async () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      day: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
      posted: i % 4,
      completed: i % 3,
    }));
    await expectNoViolations(
      <ActivityChart points={points} labels={NETWORK_LABELS} />,
    );
  });

  it("reach chart has no axe violations", async () => {
    await expectNoViolations(
      <ReachChart
        bands={[
          { bucket: "Under 5 km", bucket_order: 1, donations: 21 },
          { bucket: "10–25 km", bucket_order: 3, donations: 103 },
        ]}
      />,
    );
  });

  it("fulfilment meter has no axe violations", async () => {
    await expectNoViolations(
      <FulfilmentMeter
        fulfilment={{
          rate: 61.6,
          numerator: 154,
          denominator: 250,
          detail: "154 of 250 listings that finished",
        }}
      />,
    );
  });

  it("stat figures have no axe violations", async () => {
    await expectNoViolations(
      <dl>
        <HeroStat label="Donations completed" value={154} hint="from 263" />
        <StatTile label="Open right now" value={10} hint="Still collectable" />
      </dl>,
    );
  });
});
