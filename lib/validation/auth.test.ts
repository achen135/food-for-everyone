import { describe, expect, it } from "vitest";

import { signInSchema, signUpSchema } from "@/lib/validation/auth";

describe("signInSchema", () => {
  it("accepts a valid email + password", () => {
    const result = signInSchema.safeParse({
      email: "a@b.org",
      password: "secretpw",
    });
    expect(result.success).toBe(true);
  });

  it("trims the email", () => {
    const result = signInSchema.parse({
      email: "  a@b.org  ",
      password: "x",
    });
    expect(result.email).toBe("a@b.org");
  });

  it("rejects a missing email", () => {
    const result = signInSchema.safeParse({ email: "", password: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", () => {
    const result = signInSchema.safeParse({ email: "nope", password: "x" });
    expect(result.success).toBe(false);
  });
});

describe("signUpSchema", () => {
  it("accepts a valid registration", () => {
    const result = signUpSchema.safeParse({
      fullName: "Jordan Rivera",
      email: "jordan@shelter.org",
      password: "at-least-8",
    });
    expect(result.success).toBe(true);
  });

  it("requires a name", () => {
    const result = signUpSchema.safeParse({
      fullName: "   ",
      email: "jordan@shelter.org",
      password: "at-least-8",
    });
    expect(result.success).toBe(false);
  });

  it("requires >= 8 char password", () => {
    const result = signUpSchema.safeParse({
      fullName: "Jordan",
      email: "jordan@shelter.org",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a password over 72 chars (bcrypt limit)", () => {
    const result = signUpSchema.safeParse({
      fullName: "Jordan",
      email: "jordan@shelter.org",
      password: "x".repeat(73),
    });
    expect(result.success).toBe(false);
  });
});
