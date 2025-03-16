import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "@/lib/auth/redirect";

describe("safeRedirectPath", () => {
  it("keeps a same-origin absolute path", () => {
    expect(safeRedirectPath("/app/map")).toBe("/app/map");
  });

  it("falls back for external URLs", () => {
    expect(safeRedirectPath("https://evil.example/app")).toBe("/app");
  });

  it("falls back for protocol-relative URLs", () => {
    expect(safeRedirectPath("//evil.example")).toBe("/app");
  });

  it("falls back for a non-path value", () => {
    expect(safeRedirectPath("app")).toBe("/app");
  });

  it("falls back for null / undefined", () => {
    expect(safeRedirectPath(null)).toBe("/app");
    expect(safeRedirectPath(undefined)).toBe("/app");
  });

  it("honors a custom fallback", () => {
    expect(safeRedirectPath(null, "/")).toBe("/");
  });
});
