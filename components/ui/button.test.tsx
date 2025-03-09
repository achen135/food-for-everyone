import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Register</Button>);
    expect(
      screen.getByRole("button", { name: "Register" }),
    ).toBeInTheDocument();
  });

  it("honors the disabled prop", () => {
    render(<Button disabled>Sign in</Button>);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });
});
