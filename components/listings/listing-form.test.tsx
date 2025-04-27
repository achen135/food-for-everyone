import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { createListingAction, refresh } = vi.hoisted(() => ({
  createListingAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/app/app/listings/actions", () => ({ createListingAction }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

import { ListingForm } from "@/components/listings/listing-form";

describe("ListingForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefills a pickup window so posting is one field away", () => {
    render(<ListingForm />);
    const from = screen.getByLabelText("Pickup from") as HTMLInputElement;
    const until = screen.getByLabelText("Pickup until") as HTMLInputElement;

    // `datetime-local` only accepts `YYYY-MM-DDTHH:mm`; anything else and the
    // browser silently renders an empty field.
    expect(from.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(until.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(until.value) > new Date(from.value)).toBe(true);
  });

  it("blocks an empty submit", async () => {
    const user = userEvent.setup();
    render(<ListingForm />);
    await user.click(screen.getByRole("button", { name: "Post listing" }));
    expect(
      await screen.findByText("Say what you're offering"),
    ).toBeInTheDocument();
    expect(createListingAction).not.toHaveBeenCalled();
  });

  it("submits the typed values", async () => {
    createListingAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ListingForm />);

    await user.type(
      screen.getByLabelText("What are you offering?"),
      "Bread and pastries",
    );
    await user.type(screen.getByLabelText("Roughly how much?"), "2 crates");
    await user.click(screen.getByRole("button", { name: "Post listing" }));

    await waitFor(() => expect(createListingAction).toHaveBeenCalledTimes(1));
    expect(createListingAction.mock.calls[0][0]).toMatchObject({
      title: "Bread and pastries",
      quantity: "2 crates",
    });
  });

  it("resets to a fresh pickup window after posting, not to blank", async () => {
    // Regression: `reset()` was previously handed `{ start, end }` instead of
    // `{ pickupStart, pickupEnd }`. `reset` takes a DeepPartial and object
    // spread disables excess-property checks, so it type-checked and then
    // silently blanked both date inputs.
    createListingAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ListingForm />);

    await user.type(screen.getByLabelText("What are you offering?"), "Soup");
    await user.type(screen.getByLabelText("Roughly how much?"), "20 portions");
    await user.click(screen.getByRole("button", { name: "Post listing" }));

    await waitFor(() =>
      expect(screen.getByLabelText("What are you offering?")).toHaveValue(""),
    );
    expect(screen.getByLabelText("Pickup from")).not.toHaveValue("");
    expect(screen.getByLabelText("Pickup until")).not.toHaveValue("");
  });

  it("shows a server-side field error", async () => {
    createListingAction.mockResolvedValue({
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: { title: ["That title is not allowed"] },
    });
    const user = userEvent.setup();
    render(<ListingForm />);

    await user.type(screen.getByLabelText("What are you offering?"), "Soup");
    await user.type(screen.getByLabelText("Roughly how much?"), "20 portions");
    await user.click(screen.getByRole("button", { name: "Post listing" }));

    expect(
      await screen.findByText("That title is not allowed"),
    ).toBeInTheDocument();
  });
});
