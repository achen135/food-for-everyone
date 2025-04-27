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

describe("OrganizationForm — changing the address", () => {
  beforeEach(() => vi.clearAllMocks());

  async function pickChicago(user: ReturnType<typeof userEvent.setup>) {
    searchAddressAction.mockResolvedValue({
      ok: true,
      results: [
        {
          label: "233 S Wacker Dr, Chicago",
          latitude: 41.878738,
          longitude: -87.6359612,
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Change address" }));
    await user.type(
      await screen.findByLabelText("Address to search"),
      "233 S Wacker",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
  }

  it("does not submit the organization form when searching", async () => {
    // Regression: Radix portals the dialog out of the DOM, but React events
    // bubble through the React tree, where the dialog is still inside the
    // organization <form>. Pressing Search therefore submitted that form with
    // unchanged values — "Organization updated", then a redirect away from the
    // page, before the user had picked anything.
    saveOrganizationAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<OrganizationForm initial={existing} />);

    await pickChicago(user);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "233 S Wacker Dr, Chicago" }),
      ).toBeInTheDocument(),
    );
    expect(saveOrganizationAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("sends the newly picked address AND its coordinates", async () => {
    saveOrganizationAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<OrganizationForm initial={existing} />);

    await pickChicago(user);
    await user.click(
      await screen.findByRole("button", { name: "233 S Wacker Dr, Chicago" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Address to search"),
      ).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveOrganizationAction).toHaveBeenCalledTimes(1),
    );
    expect(saveOrganizationAction.mock.calls[0][0]).toMatchObject({
      address: "233 S Wacker Dr, Chicago",
      latitude: 41.878738,
      longitude: -87.6359612,
    });
  });
});
