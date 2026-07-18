import { describe, expect, it } from "vitest";
import { mapSettledLimit } from "../src/generate/concurrency.js";

describe("mapSettledLimit", () => {
  it("preserves item order while collecting fulfilled and rejected results", async () => {
    const settled = await mapSettledLimit([1, 2, 3, 4], 2, async (value) => {
      if (value === 3) throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
      return value * 10;
    });

    expect(settled).toHaveLength(4);
    expect(settled[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(settled[1]).toEqual({ status: "fulfilled", value: 20 });
    expect(settled[2]?.status).toBe("rejected");
    expect(settled[3]).toEqual({ status: "fulfilled", value: 40 });
  });
});
