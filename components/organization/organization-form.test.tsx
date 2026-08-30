import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Organization } from "@/lib/db";

const saveOrganizationAction = vi.fn();
const searchAddressAction = vi.fn();
vi.mock("@/app/app/organization/actions", () => ({
  saveOrganizationAction: (...args: unknown[]) =>
    saveOrganizationAction(...args),
  searchAddressAction: (...args: unknown[]) => searchAddressAction(...args),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

import { OrganizationForm } from "@/components/organization/organization-form";

const existing = {
  id: "org-1",
  owner_id: "user-1",
  name: "Old Name",
  type: "donor",
  description: "We cook meals.",
  email: "kitchen@example.org",
  phone: "",
  website: "",
  address: "1 Old St, Town",
  location: null,
  verified: false,
  created_at: "2026-08-29T00:00:00Z",
  updated_at: "2026-08-29T00:00:00Z",
} satisfies Organization;

describe("OrganizationForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the core fields", () => {
    render(<OrganizationForm initial={null} />);
    expect(screen.getByLabelText("Organization name")).toBeInTheDocument();
    expect(screen.getByText("We donate food")).toBeInTheDocument();
    expect(screen.getByText("We receive food")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    expect(screen.getByLabelText("Website")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Search address" }),
    ).toBeInTheDocument();
  });

  it("blocks submit and surfaces validation when empty", async () => {
    const user = userEvent.setup();
    render(<OrganizationForm initial={null} />);

    await user.click(
      screen.getByRole("button", { name: "Create organization" }),
    );

    expect(
      await screen.findByText("Organization name is required"),
    ).toBeInTheDocument();
    expect(saveOrganizationAction).not.toHaveBeenCalled();
  });

  it("submits an edit through saveOrganizationAction and navigates", async () => {
    saveOrganizationAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<OrganizationForm initial={existing} />);

    const name = screen.getByLabelText("Organization name");
    await user.clear(name);
    await user.type(name, "New Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveOrganizationAction).toHaveBeenCalledTimes(1),
    );
    expect(saveOrganizationAction.mock.calls[0][0]).toMatchObject({
      name: "New Name",
      type: "donor",
      email: "kitchen@example.org",
      address: "1 Old St, Town",
      latitude: null,
      longitude: null,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app"));
  });

  it("shows the server's field errors on a failed save", async () => {
    saveOrganizationAction.mockResolvedValue({
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: { name: ["That name is taken in your area"] },
    });
    const user = userEvent.setup();
    render(<OrganizationForm initial={existing} />);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("That name is taken in your area"),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
