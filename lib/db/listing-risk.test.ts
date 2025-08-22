import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { select } = vi.hoisted(() => ({ select: vi.fn() }));

// One chainable stub shaped like the PostgREST builder the real call uses:
// `.from(...).select(...).in(...)` resolves to `{ data, error }`.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ in: select }),
    }),
  }),
}));

import { getListingRiskTiers } from "@/lib/db/listing-risk";

const LISTING_A = "aaaaaaaa-1111-4111-8111-111111111111";
const LISTING_B = "bbbbbbbb-2222-4222-8222-222222222222";

/**
 * The M14 web read-hook.
 *
 * Every test here is really the same assertion from a different angle: this
 * feature must be **invisible when it has nothing to say**. The flag is off by
 * default, the table may not exist in a given environment, the batch job may
 * never have run, and a listing that closed has had its row pruned. None of
 * those is an error condition, and none may reach the user.
 *
 * The flag is checked here for UX, not access control — what actually protects
 * the data is the RLS policy on `listing_risk`. See the migration.
 */
describe("getListingRiskTiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ML_RISK_ESCALATION", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the tier for each listing that has one", async () => {
    select.mockResolvedValue({
      data: [
        { listing_id: LISTING_A, risk_tier: "high" },
        { listing_id: LISTING_B, risk_tier: "low" },
      ],
      error: null,
    });

    const tiers = await getListingRiskTiers([LISTING_A, LISTING_B]);

    expect(tiers.get(LISTING_A)).toBe("high");
    expect(tiers.get(LISTING_B)).toBe("low");
  });

  it("does not query at all when the flag is off", async () => {
    vi.stubEnv("ML_RISK_ESCALATION", "");

    const tiers = await getListingRiskTiers([LISTING_A]);

    expect(tiers.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("treats an unset flag as off", async () => {
    vi.stubEnv("ML_RISK_ESCALATION", undefined);

    await expect(getListingRiskTiers([LISTING_A])).resolves.toHaveProperty(
      "size",
      0,
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("does not query when there are no listings on screen", async () => {
    const tiers = await getListingRiskTiers([]);

    expect(tiers.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("falls back silently when the query errors", async () => {
    // The realistic case: the migration has not been applied in this
    // environment, so PostgREST answers 404 for an unknown relation.
    select.mockResolvedValue({
      data: null,
      error: { message: 'relation "public.listing_risk" does not exist' },
    });

    await expect(getListingRiskTiers([LISTING_A])).resolves.toHaveProperty(
      "size",
      0,
    );
  });

  it("falls back silently when the client throws", async () => {
    select.mockRejectedValue(new Error("network down"));

    await expect(getListingRiskTiers([LISTING_A])).resolves.toHaveProperty(
      "size",
      0,
    );
  });

  it("returns an empty map, not undefined, when no rows come back", async () => {
    select.mockResolvedValue({ data: [], error: null });

    const tiers = await getListingRiskTiers([LISTING_A]);

    expect(tiers.size).toBe(0);
    expect(tiers.get(LISTING_A)).toBeUndefined();
  });

  it("drops a tier value it does not recognise", async () => {
    // `listing_risk` is written by a different subsystem through a different
    // key. The column has a check constraint, but the reader does not depend
    // on it: an unknown tier must not reach the UI.
    select.mockResolvedValue({
      data: [
        { listing_id: LISTING_A, risk_tier: "critical" },
        { listing_id: LISTING_B, risk_tier: "high" },
      ],
      error: null,
    });

    const tiers = await getListingRiskTiers([LISTING_A, LISTING_B]);

    expect(tiers.has(LISTING_A)).toBe(false);
    expect(tiers.get(LISTING_B)).toBe("high");
  });

  it("asks for exactly the listings it was given", async () => {
    select.mockResolvedValue({ data: [], error: null });

    await getListingRiskTiers([LISTING_A, LISTING_B]);

    expect(select).toHaveBeenCalledWith("listing_id", [LISTING_A, LISTING_B]);
  });
});
