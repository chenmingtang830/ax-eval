import { describe, expect, it } from "vitest";
import {
  enforceOpenRouterRequest,
  routeEvidenceFromResponse,
  startOpenRouterGateway,
  validateResolvedProvider,
} from "../src/harness/openrouter-gateway.js";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policy = {
  model: "deepseek/deepseek-v4-flash-0731",
  canonical_model: "deepseek/deepseek-v4-flash-20260731",
  provider: "deepseek",
} as const;

describe("OpenRouter route enforcement", () => {
  it("pins model and provider and disables every fallback path", () => {
    const result = enforceOpenRouterRequest({ model: policy.canonical_model, stream: true, max_completion_tokens: 128, provider: { sort: "price" } }, policy);
    expect(result).toMatchObject({
      model: policy.model,
      provider: { only: ["deepseek"], order: ["deepseek"], allow_fallbacks: false, require_parameters: true },
    });
    expect((result.provider as Record<string, unknown>).sort).toBe("price");
    expect(result).toHaveProperty("max_tokens", 128);
    expect(result).not.toHaveProperty("max_completion_tokens");
  });

  it("fails closed when a caller asks for another model", () => {
    expect(() => enforceOpenRouterRequest({ model: "z-ai/glm-5.2" }, policy)).toThrow(/model route mismatch/);
  });

  it("requires a resolved provider attestation", () => {
    const headers = new Headers({ "x-openrouter-provider": "deepseek/production", "x-openrouter-generation-id": "gen-1" });
    const evidence = routeEvidenceFromResponse(headers, { usage: { prompt_tokens: 3, completion_tokens: 4 }, cost: 0.01 });
    expect(evidence).toMatchObject({ resolved_provider: "deepseek/production", generation_id: "gen-1", cost_usd: 0.01, token_usage: { prompt_tokens: 3, completion_tokens: 4 } });
    expect(validateResolvedProvider(evidence, "deepseek")).toBe(true);
    expect(validateResolvedProvider({ ...evidence, resolved_provider: "Z.AI" }, "z-ai")).toBe(true);
    expect(validateResolvedProvider({ ...evidence, resolved_provider: "Google" }, "google-vertex")).toBe(true);
    expect(validateResolvedProvider({ ...evidence, resolved_provider: "Moonshot AI" }, "moonshotai")).toBe(true);
    expect(validateResolvedProvider({ ...evidence, resolved_provider: "other" }, "deepseek")).toBe(false);
    expect(validateResolvedProvider({ ...evidence, resolved_provider: null }, "deepseek")).toBe(false);
  });

  it("forwards only the enforced route and fails closed on an unverified provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "ax-openrouter-test-"));
    const ledgerPath = join(root, "route.jsonl");
    const seen: Record<string, unknown>[] = [];
    const gateway = await startOpenRouterGateway({
      policy,
      apiKey: "controller-secret",
      ledgerPath,
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "gen-1", choices: [], usage: { total_tokens: 2 } }), {
          status: 200,
          headers: { "content-type": "application/json", "x-openrouter-provider": "deepseek/production" },
        });
      },
    });
    try {
      const response = await fetch("http://127.0.0.1:" + gateway.port + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: policy.canonical_model, provider: { sort: "latency" } }),
      });
      expect(response.status).toBe(200);
      expect(seen[0]).toMatchObject({
        model: policy.model,
        provider: { only: ["deepseek"], order: ["deepseek"], allow_fallbacks: false, require_parameters: true, sort: "latency" },
      });
      expect(readFileSync(ledgerPath, "utf8")).toContain('"outcome":"ok"');
    } finally {
      await gateway.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
