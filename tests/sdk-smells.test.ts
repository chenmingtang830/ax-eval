import { describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import { auditSdkSurfaceQuality } from "../src/static/sdk-smells.js";

describe("SDK surface-quality audit", () => {
  it("scores a complete SDK surface as agent-ready", () => {
    const pack = TargetPackSchema.parse({
      name: "demo",
      standard_set_version: "sdk-quality-v1",
      run_id: "sdk-quality",
      generated_by: "fixture",
      base_url: "https://api.demo.test",
      auth: { type: "bearer", env: "DEMO_TOKEN" },
      surfaces: {
        sdk: {
          package: "@demo/sdk",
          language: "typescript",
          install: "npm install @demo/sdk",
          reference_url: "https://docs.demo.test/sdk/reference",
          examples_url: "https://docs.demo.test/sdk/examples",
          types_url: "https://docs.demo.test/sdk/typedoc",
        },
      },
      tasks: [],
    });

    const audit = auditSdkSurfaceQuality(pack);

    expect(audit.score).toBe(100);
    expect(audit.totalFindings).toBe(0);
  });

  it("flags weak SDK metadata that leaves agents guessing", () => {
    const pack = TargetPackSchema.parse({
      name: "demo",
      standard_set_version: "sdk-quality-v1",
      run_id: "sdk-quality",
      generated_by: "fixture",
      base_url: "https://api.demo.test",
      auth: { type: "bearer", env: "" },
      surfaces: {
        sdk: {
          package: "demo-sdk",
          language: "ruby",
        },
      },
      tasks: [],
    });

    const audit = auditSdkSurfaceQuality(pack);

    expect(audit.score).toBeLessThan(60);
    expect(audit.byCategory.INSTALL).toBe(1);
    expect(audit.byCategory.REFERENCE).toBe(1);
    expect(audit.byCategory.AUTH).toBe(1);
    expect(audit.byCategory.EXAMPLES).toBe(1);
    expect(audit.byCategory.TYPES).toBe(1);
  });
});
