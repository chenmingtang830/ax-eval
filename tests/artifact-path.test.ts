import { describe, expect, it } from "vitest";
import { assertArtifactSegment } from "../src/generate/artifact-path.js";

describe("artifact path segments", () => {
  it("accepts stable slugs and versions", () => {
    expect(assertArtifactSegment("daeb-1-v3", "suite name")).toBe("daeb-1-v3");
    expect(assertArtifactSegment("vendor.example", "vendor slug")).toBe("vendor.example");
  });

  it("rejects traversal and nested paths", () => {
    expect(() => assertArtifactSegment("../outside", "suite name")).toThrow(/safe artifact path segment/);
    expect(() => assertArtifactSegment("nested/path", "suite name")).toThrow(/safe artifact path segment/);
    expect(() => assertArtifactSegment("/absolute", "vendor slug")).toThrow(/safe artifact path segment/);
  });
});
