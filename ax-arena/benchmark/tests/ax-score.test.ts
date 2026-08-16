import { describe, expect, it } from "vitest";

import { axCompositeScore, harmonicMean } from "../src/publication/ax-score.js";

describe("AX composite score", () => {
  it("uses the harmonic mean of usability and discovery", () => {
    expect(harmonicMean(1, 0.8)).toBeCloseTo(0.8888888889);
    expect(axCompositeScore(1, 0.8)).toEqual({
      usability: 1,
      discovery: 0.8,
      ax_score: expect.closeTo(0.8888888889),
      formula: "harmonic_mean",
    });
  });

  it("does not let one perfect component hide a zero component", () => {
    expect(harmonicMean(1, 0)).toBe(0);
  });

  it("rejects scores outside the normalized range", () => {
    expect(() => harmonicMean(1.01, 0.8)).toThrow("left score");
    expect(() => harmonicMean(0.8, -0.01)).toThrow("right score");
  });
});
