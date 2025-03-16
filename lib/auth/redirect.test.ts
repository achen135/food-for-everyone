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

  it("falls back for backslash-escaped authority bypasses", () => {
    // `/\` puts the WHATWG URL parser into "special authority ignore slashes"
    // state, so a relative Location header resolves these to an external host.
    expect(safeRedirectPath("/\\evil.example")).toBe("/app");
    expect(safeRedirectPath("/\\/evil.example")).toBe("/app");
    expect(safeRedirectPath("/app\\..\\evil.example")).toBe("/app");
  });

  it("falls back for values containing control characters", () => {
    expect(safeRedirectPath("/\u0009/evil.example")).toBe("/app");
    expect(safeRedirectPath("/\u0000app")).toBe("/app");
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
