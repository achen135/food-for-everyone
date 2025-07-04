import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";

const { getUser, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  redirect: vi.fn(),
}));

// The layout now reads its user through `@/lib/auth/user`, which is
// server-only; mocking the Supabase client underneath keeps the real
// memoisation helper in the path rather than stubbing it out.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import AuthLayout from "@/app/(auth)/layout";

/**
 * Guards the M9 fix for the auth dead end: /sign-in, /sign-up and
 * /verify-email linked only to each other, so the only way back to the landing
 * page was the browser's back button. The route home lives in the layout, so
 * testing it here covers all three pages at once — which is also why a new
 * page added to this group cannot reintroduce the bug.
 */
async function renderLayout() {
  const ui = await AuthLayout({ children: <p>form goes here</p> });
  return render(ui);
}

describe("auth layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it("offers a link back to the landing page", async () => {
    await renderLayout();

    const home = screen.getByRole("link", { name: /food for everyone/i });
    expect(home).toHaveAttribute("href", "/");
  });

  it("puts the route home in a banner landmark, not loose in the page", async () => {
    await renderLayout();

    const banner = screen.getByRole("banner");
    expect(
      within(banner).getByRole("link", { name: /food for everyone/i }),
    ).toBeInTheDocument();
  });

  it("keeps rendering the page it wraps", async () => {
    await renderLayout();

    expect(screen.getByText("form goes here")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = await renderLayout();

    const results = await axe(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect((results.violations ?? []).map((v) => `${v.id}: ${v.help}`)).toEqual(
      [],
    );
  });

  it("still sends a signed-in user to /app", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });

    await renderLayout();

    // The header must not have changed who is allowed to sit on these pages.
    expect(redirect).toHaveBeenCalledWith("/app");
  });
});
