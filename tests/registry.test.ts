import { describe, expect, it } from "vitest";
import { availableHarnesses, getHarness } from "../src/adapters/registry.js";
import { HermesHarness } from "../src/adapters/hermes.js";

describe("harness registry", () => {
  it("registers the keyless harnesses", () => {
    const names = availableHarnesses();
    for (const expected of ["mock", "mock-weak", "hermes"]) {
      expect(names).toContain(expected);
    }
  });

  it("throws for an unknown harness", () => {
    expect(() => getHarness("nope")).toThrow(/unknown harness/);
  });

  it("returns a fresh instance each call", () => {
    expect(getHarness("mock")).not.toBe(getHarness("mock"));
  });

  it("hermes is a keyless stub", () => {
    const h = getHarness("hermes");
    expect(h).toBeInstanceOf(HermesHarness);
    expect(h.requiresKey).toBe(false);
    expect((h as HermesHarness).isStub).toBe(true);
  });
});
