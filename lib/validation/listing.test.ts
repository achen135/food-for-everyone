import { describe, expect, it } from "vitest";

import {
  effectiveStatus,
  isExpired,
  listingSchema,
  messageForCode,
  toInstant,
} from "@/lib/validation/listing";

const valid = {
  title: "Prepared sandwiches",
  quantity: "About 40 portions",
  pickupStart: "2026-09-01T18:00",
  pickupEnd: "2026-09-01T22:00",
  notes: "",
};

describe("listingSchema", () => {
  it("accepts a valid listing", () => {
    expect(listingSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a title and a quantity", () => {
    expect(listingSchema.safeParse({ ...valid, title: "  " }).success).toBe(
      false,
    );
    expect(listingSchema.safeParse({ ...valid, quantity: "" }).success).toBe(
      false,
    );
  });

  it("rejects a window that ends before it starts", () => {
    const result = listingSchema.safeParse({
      ...valid,
      pickupStart: "2026-09-01T22:00",
      pickupEnd: "2026-09-01T18:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a zero-length window", () => {
    expect(
      listingSchema.safeParse({
        ...valid,
        pickupStart: "2026-09-01T18:00",
        pickupEnd: "2026-09-01T18:00",
      }).success,
    ).toBe(false);
  });

  it("rejects an absurdly long window", () => {
    expect(
      listingSchema.safeParse({
        ...valid,
        pickupStart: "2026-09-01T18:00",
        pickupEnd: "2026-12-01T18:00",
      }).success,
    ).toBe(false);
  });

  it("rejects an unparseable date", () => {
    expect(
      listingSchema.safeParse({ ...valid, pickupStart: "tomorrow-ish" })
        .success,
    ).toBe(false);
  });

  it("rejects notes over 1000 characters", () => {
    expect(
      listingSchema.safeParse({ ...valid, notes: "x".repeat(1001) }).success,
    ).toBe(false);
  });
});

describe("toInstant", () => {
  it("converts a local datetime string to an ISO instant", () => {
    const iso = toInstant("2026-09-01T18:00");
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getMinutes()).toBe(0);
  });

  it("returns null for junk", () => {
    expect(toInstant("not a date")).toBeNull();
  });
});

describe("isExpired", () => {
  const now = new Date("2026-09-01T20:00:00Z");

  it("is true once the window has closed", () => {
    expect(isExpired("2026-09-01T19:00:00Z", now)).toBe(true);
  });

  it("is false while the window is open", () => {
    expect(isExpired("2026-09-01T21:00:00Z", now)).toBe(false);
  });

  it("treats the exact end instant as expired", () => {
    expect(isExpired("2026-09-01T20:00:00Z", now)).toBe(true);
  });
});

describe("effectiveStatus", () => {
  const now = new Date("2026-09-01T20:00:00Z");

  it("derives expired from an open listing past its window", () => {
    expect(effectiveStatus("open", "2026-09-01T19:00:00Z", now)).toBe(
      "expired",
    );
  });

  it("leaves an open listing inside its window alone", () => {
    expect(effectiveStatus("open", "2026-09-01T21:00:00Z", now)).toBe("open");
  });

  it("never overrides a stored terminal status", () => {
    // A claimed listing whose window lapsed is still claimed — someone is
    // coming for it. Only `open` decays into `expired`.
    expect(effectiveStatus("claimed", "2026-09-01T19:00:00Z", now)).toBe(
      "claimed",
    );
    expect(effectiveStatus("completed", "2026-09-01T19:00:00Z", now)).toBe(
      "completed",
    );
    expect(effectiveStatus("cancelled", "2026-09-01T19:00:00Z", now)).toBe(
      "cancelled",
    );
  });
});

describe("messageForCode", () => {
  it("returns null for success", () => {
    expect(messageForCode("ok")).toBeNull();
  });

  it("has copy for every failure code", () => {
    const codes = [
      "no_organization",
      "not_donor",
      "not_recipient",
      "demo_account",
      "not_found",
      "not_open",
      "not_claimed",
      "no_claim",
      "expired",
      "already_claimed",
      "bad_window",
    ] as const;
    for (const code of codes) {
      expect(messageForCode(code), code).toBeTruthy();
    }
  });

  it("explains a lost race in the claimant's terms", () => {
    expect(messageForCode("already_claimed")).toMatch(/someone else/i);
  });
});
