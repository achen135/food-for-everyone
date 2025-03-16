import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const signIn = vi.fn();
vi.mock("@/app/(auth)/actions", () => ({
  signIn: (...args: unknown[]) => signIn(...args),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { SignInForm } from "@/components/auth/sign-in-form";

describe("SignInForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders email and password fields", () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("blocks submit and shows a message when the form is empty", async () => {
    const user = userEvent.setup();
    render(<SignInForm />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("submits valid input to the action, including redirectTo", async () => {
    signIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SignInForm redirectTo="/app/map" />);

    await user.type(screen.getByLabelText("Email"), "a@b.org");
    await user.type(screen.getByLabelText("Password"), "secretpw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith({
        email: "a@b.org",
        password: "secretpw",
        redirectTo: "/app/map",
      }),
    );
  });
});
