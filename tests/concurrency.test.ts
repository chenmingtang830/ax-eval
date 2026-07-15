import { describe, expect, it } from "vitest";
import { mapSettledLimit } from "../src/generate/concurrency.js";

describe("mapSettledLimit", () => {
  it("preserves order and enforces the concurrency bound", async () => {
    let active = 0;
    let maximumActive = 0;
    const settled = await mapSettledLimit([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      active -= 1;
      if (value === 3) throw new Error("expected failure");
      return value * 10;
    });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect((settled[3] as PromiseFulfilledResult<number>).value).toBe(40);
  });

  it("rejects invalid limits", async () => {
    await expect(mapSettledLimit([1], 0, async (value) => value)).rejects.toThrow(/positive integer/);
  });
});
