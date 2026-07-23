import { describe, expect, it } from "vitest";
import { buildVerificationClientOptions } from "../src/generate/verification-client.js";
import { TargetPackSchema } from "../src/schemas.js";

describe("verification client", () => {
  it("uses the agent-discovered Convex deployment and no auth for function read-back", () => {
    const pack = TargetPackSchema.parse({
      name: "convex",
      run_id: "2026-07-02-demo",
      base_url: "${CONVEX_URL}",
      auth: { type: "bearer", env: "CONVEX_DEPLOY_KEY", header: "Authorization" },
      tasks: [],
    });
    const opts = buildVerificationClientOptions(pack, {
      profile: "low",
      ns: "demo",
      surface: "api",
      discovery: {
        base_url_found: "https://preview-example-123.convex.cloud",
        searches: [],
        urls_visited: [],
        endpoint_used: "POST /api/query",
        auth_scheme_found: "public Convex function endpoint",
        notes: "",
      },
      results: {},
    });

    expect(opts.baseUrl).toBe("https://preview-example-123.convex.cloud");
    expect(opts.authScheme).toBe("none");
    expect(opts.token).toBe("");
    expect(opts.authHeader).toBeUndefined();
  });
});
