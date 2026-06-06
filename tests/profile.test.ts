import { describe, expect, it } from "vitest";
import { getProfile, profileLabel, profilesAreCrossModel, PROFILES } from "../src/harness/profile.js";

describe("harness profiles", () => {
  it("floor/ceiling share the host model (effort-only spread)", () => {
    expect(profilesAreCrossModel([PROFILES.floor, PROFILES.ceiling])).toBe(false);
  });

  it("mixing in a model profile makes the run cross-model", () => {
    expect(profilesAreCrossModel([PROFILES.floor, PROFILES.sonnet])).toBe(true);
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
