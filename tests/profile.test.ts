import { describe, expect, it } from "vitest";
import { getProfile, profileLabel, profilesAreCrossModel, PROFILES } from "../src/harness/profile.js";

describe("harness profiles", () => {
  it("low/high share the host model (effort-only spread)", () => {
    expect(profilesAreCrossModel([PROFILES.low, PROFILES.high])).toBe(false);
  });

  it("floor/ceiling resolve to low/high as back-compat aliases", () => {
    expect(getProfile("floor")).toBe(PROFILES.low);
    expect(getProfile("ceiling")).toBe(PROFILES.high);
  });

  it("mixing in a model profile makes the run cross-model", () => {
    expect(profilesAreCrossModel([PROFILES.low, PROFILES.sonnet])).toBe(true);
    expect(profilesAreCrossModel([PROFILES.sonnet, PROFILES.gpt5])).toBe(true);
  });

  it("model profiles carry distinct model labels", () => {
    expect(getProfile("sonnet").model).toBe("claude-4.6-sonnet");
    expect(getProfile("gpt5").model).toBe("gpt-5.5");
    expect(profileLabel(PROFILES.sonnet)).toContain("claude-4.6-sonnet");
  });

  it("unknown profile throws", () => {
    expect(() => getProfile("nope")).toThrow(/unknown profile/);
  });
});
