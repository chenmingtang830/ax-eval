import { describe, expect, it } from "vitest";
import { classifyHealthCheckSignals, healthCheckPack } from "../src/target/health-check.js";
import { TargetPackSchema } from "../src/schemas.js";

describe("health-check signals", () => {
  it("flags leftover candidates as namespace pollution risk", () => {
    expect(classifyHealthCheckSignals({
      candidates: 3,
      errors: [],
      message: "found 3 probe resources",
    })).toEqual({
      namespace_pollution_risk: true,
      quota_pressure_hint: false,
      leftover_candidates: 3,
    });
  });

  it("flags quota/rate-limit wording", () => {
    expect(classifyHealthCheckSignals({
      candidates: 0,
      errors: ["HTTP 429 Too Many Requests: quota exceeded"],
      message: "list failed",
    })).toMatchObject({
      namespace_pollution_risk: false,
      quota_pressure_hint: true,
      leftover_candidates: 0,
    });
  });

  it("preserves the provider requirement for unsupported database health checks", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      version: "1",
      standard_set_version: "health-check-provider-v1",
      run_id: "health-check-provider",
      generated_by: "deterministic@no-model",
      auth_method: "none",
      auth: { type: "none" },
      base_url: "https://example.invalid",
      site_url: "",
      docs_urls: [],
      tasks: [],
    });
    const client = {
      get: async () => {
        throw new Error("unsupported health check must not use the HTTP client");
      },
      del: async () => {
        throw new Error("unsupported health check must not use the HTTP client");
      },
    };

    const result = await healthCheckPack(pack, client, {}, { reclaim: true });
    expect(result.supported).toBe(false);
    expect(result.message).toContain("health-check unavailable");
    expect(result.message).toContain("requires an explicit ResetProvider");
    expect(result.message).not.toContain("reclaimed 0/0");
  });
});
