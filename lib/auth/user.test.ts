import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getUser, getSession } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser, getSession } }),
}));

import {
  getAuthCallCount,
  loadAuthenticatedUser,
  resetAuthCallCount,
} from "@/lib/auth/user";

/**
 * These cover the *read*, not the memoisation. Under Vitest `react` resolves to
 * the client build, whose `cache()` is an unconditional pass-through
 * (`return fn.apply(null, arguments)`), so `getAuthenticatedUser`'s dedup
 * cannot be observed here at all — asserting it would be asserting nothing.
 * The dedup is measured by running the app with `BENCHMARK_MODE=1` and reading
 * `authCalls` off /api/benchmark.
 *
 * What *is* worth pinning down here is the security property the M9 brief
 * flagged: this must keep revalidating the token rather than trusting the
 * cookie.
 */
describe("loadAuthenticatedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCallCount();
  });

  it("returns the authenticated user", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });

    await expect(loadAuthenticatedUser()).resolves.toEqual({ id: "user-a" });
  });

  it("returns null when nobody is signed in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await expect(loadAuthenticatedUser()).resolves.toBeNull();
  });

  it("normalises a missing user to null rather than undefined", async () => {
    getUser.mockResolvedValue({ data: {} });

    await expect(loadAuthenticatedUser()).resolves.toBeNull();
  });

  it("revalidates the token — getUser, never getSession", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });

    await loadAuthenticatedUser();

    // getSession trusts the cookie without asking the auth server. Swapping to
    // it would make this helper faster and wrong, and is the specific mistake
    // lib/supabase/middleware.ts:73 warns about.
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("counts each real round-trip, so the dedup is measurable at runtime", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });

    await loadAuthenticatedUser();
    await loadAuthenticatedUser();

    expect(getAuthCallCount()).toBe(2);
  });

  it("resets the counter", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });
    await loadAuthenticatedUser();

    resetAuthCallCount();

    expect(getAuthCallCount()).toBe(0);
  });
});
