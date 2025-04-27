import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// `vi.mock` is hoisted above every `const` in the file, so mocks that are read
// at registration time (rather than called later) must come from `vi.hoisted`.
const { toastSuccess, toastError, refresh } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

import { ListingActionButton } from "@/components/listings/listing-action-button";

const LISTING_ID = "11111111-1111-1111-1111-111111111111";

describe("ListingActionButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls the action with the listing id", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <ListingActionButton
        listingId={LISTING_ID}
        action={action}
        label="Claim"
        pendingLabel="Claiming…"
        successMessage="Claimed."
      />,
    );

    await user.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith(LISTING_ID));
    expect(toastSuccess).toHaveBeenCalledWith("Claimed.");
  });

  it("surfaces the server's message when the action fails", async () => {
    const action = vi.fn().mockResolvedValue({
      ok: false,
      message: "Someone else claimed that listing first.",
    });
    const user = userEvent.setup();
    render(
      <ListingActionButton
        listingId={LISTING_ID}
        action={action}
        label="Claim"
        pendingLabel="Claiming…"
        successMessage="Claimed."
      />,
    );

    await user.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Someone else claimed that listing first.",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("refreshes after a lost race so the stale row disappears", async () => {
    const action = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "Someone else claimed it." });
    const user = userEvent.setup();
    render(
      <ListingActionButton
        listingId={LISTING_ID}
        action={action}
        label="Claim"
        pendingLabel="Claiming…"
        successMessage="Claimed."
      />,
    );

    await user.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("disables while in flight so one click is one claim", async () => {
    let resolve: (v: { ok: true }) => void = () => {};
    const action = vi.fn(() => new Promise<{ ok: true }>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(
      <ListingActionButton
        listingId={LISTING_ID}
        action={action}
        label="Claim"
        pendingLabel="Claiming…"
        successMessage="Claimed."
      />,
    );

    await user.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Claiming…" })).toBeDisabled(),
    );

    await user.click(screen.getByRole("button", { name: "Claiming…" }));
    expect(action).toHaveBeenCalledTimes(1);

    resolve({ ok: true });
  });
});
