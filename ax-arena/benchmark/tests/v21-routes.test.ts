import { describe, expect, it } from "vitest";
import { V21_HARNESS_PINS, V21_ROUTE_MANIFEST, validateV21HarnessVersion, v21RoutePolicy } from "../src/runtime/v21-routes.js";

describe("V2.1 route manifest", () => {
  it("pins all canonical model/provider pairs with no fallback or batch", () => {
    expect(V21_ROUTE_MANIFEST.gateway).toBe("openrouter");
    expect(V21_ROUTE_MANIFEST.reasoning_effort).toBe("high");
    expect(V21_ROUTE_MANIFEST.allow_fallbacks).toBe(false);
    expect(V21_ROUTE_MANIFEST.batch).toBe(false);
    expect(V21_HARNESS_PINS).toMatchObject({ pi: { version: "0.84.2" }, opencode: { version: "1.18.18" } });
    expect(v21RoutePolicy("z-ai/glm-5.2-20260616")).toMatchObject({
      canonical_model: "z-ai/glm-5.2-20260616",
      provider: "z-ai",
      data_collection: "allow",
    });
  });

  it("rejects aliases and unknown models", () => {
    expect(() => v21RoutePolicy("deepseek/deepseek-v4-flash-0731")).toThrow(/canonical slug/);
    expect(() => v21RoutePolicy("other/model")).toThrow(/canonical slug/);
  });

  it("fails closed on harness binary drift", () => {
    validateV21HarnessVersion("pi", "v0.84.2");
    expect(() => validateV21HarnessVersion("opencode", "1.18.9")).toThrow(/binary drift/);
  });
});
