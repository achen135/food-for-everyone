import { beforeEach, describe, expect, it } from "vitest";

import { getReadCount, resetReadCount, tracked } from "@/lib/db/instrument";

describe("tracked", () => {
  beforeEach(() => resetReadCount());

  it("increments the read counter once per call", async () => {
    await tracked("t.a", () => Promise.resolve("a"));
    await tracked("t.b", () => Promise.resolve("b"));
    expect(getReadCount()).toBe(2);
  });

  it("returns the wrapped result", async () => {
    await expect(tracked("t", () => Promise.resolve(42))).resolves.toBe(42);
  });

  it("still counts a read when the operation rejects", async () => {
    await expect(
      tracked("t", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(getReadCount()).toBe(1);
  });

  it("resetReadCount zeroes the counter", async () => {
    await tracked("t", () => Promise.resolve(null));
    resetReadCount();
    expect(getReadCount()).toBe(0);
  });
});
