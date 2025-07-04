import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// `vi.mock` is hoisted above every `const` in this file, so the fns the
// factories close over have to be hoisted with it.
const { getUser, geocodeAddress } = vi.hoisted(() => ({
  getUser: vi.fn(),
  geocodeAddress: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/geocode", () => ({ geocodeAddress }));

vi.mock("@/lib/db", () => ({
  getMyOrganization: vi.fn(),
  getMyProfile: vi.fn(),
  invalidateOrganizationCache: vi.fn(),
  upsertMyOrganization: vi.fn(),
}));

import { searchAddressAction } from "@/app/app/organization/actions";
import { OutboundPaceSaturatedError } from "@/lib/pace";
import { geocodeLimiter } from "@/lib/rate-limit";

const RESULTS = [
  { label: "1 Main St, Springfield", latitude: 39.8, longitude: -89.6 },
];

function signedInAs(id: string) {
  getUser.mockResolvedValue({ data: { user: { id } } });
}

describe("searchAddressAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geocodeLimiter.reset();
    geocodeAddress.mockResolvedValue(RESULTS);
    signedInAs("user-a");
  });

  it("returns results for a signed-in caller", async () => {
    await expect(searchAddressAction("1 Main St")).resolves.toEqual({
      ok: true,
      results: RESULTS,
    });
  });

  it("refuses an anonymous caller without geocoding", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await searchAddressAction("1 Main St");

    expect(result).toEqual({
      ok: false,
      message: "Your session expired. Sign in again.",
    });
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it("rejects a too-short query without geocoding or spending a token", async () => {
    const result = await searchAddressAction("ab");

    expect(result.ok).toBe(false);
    expect(geocodeAddress).not.toHaveBeenCalled();
    // A query zod refused never reaches Nominatim, so it must not consume the
    // budget that exists to ration outbound calls.
    expect(geocodeLimiter.size).toBe(0);
  });

  describe("per-user limiter", () => {
    it("allows a burst up to capacity, then refuses", async () => {
      for (let i = 0; i < 6; i += 1) {
        const ok = await searchAddressAction(`address number ${i}`);
        expect(ok.ok).toBe(true);
      }
      expect(geocodeAddress).toHaveBeenCalledTimes(6);

      const refused = await searchAddressAction("one too many");

      expect(refused.ok).toBe(false);
      expect(refused).toMatchObject({
        message: expect.stringMatching(/too many address searches/i),
      });
      // The refusal must stop the outbound call, not just annotate it.
      expect(geocodeAddress).toHaveBeenCalledTimes(6);
    });

    it("refuses with an error, never with an empty result list", async () => {
      for (let i = 0; i < 6; i += 1) await searchAddressAction(`addr ${i}`);

      const refused = await searchAddressAction("seventh");

      // The DoD's honesty requirement: "no results" is a claim about the
      // address. Throttling is a fact about us.
      expect(refused).not.toEqual({ ok: true, results: [] });
      expect(refused.ok).toBe(false);
    });

    it("budgets per user — one account cannot exhaust another's", async () => {
      for (let i = 0; i < 6; i += 1) await searchAddressAction(`addr ${i}`);
      expect((await searchAddressAction("blocked")).ok).toBe(false);

      signedInAs("user-b");

      await expect(searchAddressAction("1 Main St")).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  describe("global pacer saturation", () => {
    it("reports being busy, distinctly from an outage", async () => {
      geocodeAddress.mockRejectedValue(new OutboundPaceSaturatedError(4000));

      const result = await searchAddressAction("1 Main St");

      expect(result).toEqual({
        ok: false,
        message:
          "Address lookup is busy right now. Try again in a few seconds.",
      });
    });

    it("does not report saturation as an empty result list", async () => {
      geocodeAddress.mockRejectedValue(new OutboundPaceSaturatedError(4000));

      const result = await searchAddressAction("1 Main St");

      expect(result).not.toEqual({ ok: true, results: [] });
    });

    it("reports an unreachable geocoder differently again", async () => {
      geocodeAddress.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await searchAddressAction("1 Main St");

      expect(result).toEqual({
        ok: false,
        message:
          "Address lookup is unavailable right now. Try again in a moment.",
      });
    });

    it("gives the three failure modes three different messages", async () => {
      const messages = new Set<string>();

      geocodeAddress.mockRejectedValue(new OutboundPaceSaturatedError(4000));
      const busy = await searchAddressAction("addr one");
      if (!busy.ok) messages.add(busy.message);

      geocodeAddress.mockRejectedValue(new Error("boom"));
      const down = await searchAddressAction("addr two");
      if (!down.ok) messages.add(down.message);

      geocodeLimiter.reset();
      geocodeAddress.mockResolvedValue(RESULTS);
      for (let i = 0; i < 6; i += 1) await searchAddressAction(`addr ${i}`);
      const throttled = await searchAddressAction("addr seven");
      if (!throttled.ok) messages.add(throttled.message);

      expect(messages.size).toBe(3);
      for (const message of messages) {
        expect(message).not.toMatch(/no results|not found/i);
      }
    });
  });
});
