import {
  V21_MODELS,
  type V21Model,
} from "./v21-execution.js";
import type { OpenRouterRoutePolicy } from "ax-eval";
import { startOpenRouterGateway, type RunningOpenRouterGateway } from "ax-eval";

/** Locally audited binary pins. A formal controller must compare its
 * detection output to these exact versions before opening a cell. */
export const V21_HARNESS_PINS = {
  pi: { executable: "pi", version: "0.84.2" },
  opencode: { executable: "opencode", version: "1.18.18" },
} as const;

export function validateV21HarnessVersion(harness: keyof typeof V21_HARNESS_PINS, observedVersion: string): void {
  const expected = V21_HARNESS_PINS[harness].version;
  const normalized = observedVersion.trim().replace(/^v/, "");
  if (normalized !== expected) throw new Error(`V2.1 ${harness} binary drift: expected ${expected}, got ${observedVersion}`);
}

export const V21_ROUTE_POLICIES: Readonly<Record<V21Model, OpenRouterRoutePolicy>> = {
  "google/gemini-3.7-flash-20260813": {
    model: "google/gemini-3.7-flash-20260813",
    canonical_model: "google/gemini-3.7-flash-20260813",
    provider: "google-vertex",
    data_collection: "allow",
  },
  "deepseek/deepseek-v4-flash-20260731": {
    model: "deepseek/deepseek-v4-flash-20260731",
    canonical_model: "deepseek/deepseek-v4-flash-20260731",
    provider: "deepseek",
    data_collection: "allow",
  },
  "z-ai/glm-5.2-20260616": {
    model: "z-ai/glm-5.2-20260616",
    canonical_model: "z-ai/glm-5.2-20260616",
    provider: "z-ai",
    data_collection: "allow",
  },
};

export function v21RoutePolicy(model: string): OpenRouterRoutePolicy {
  if (!(V21_MODELS as readonly string[]).includes(model)) {
    throw new Error("V2.1 model is not an immutable canonical slug: " + model);
  }
  return V21_ROUTE_POLICIES[model as V21Model];
}

export const V21_ROUTE_MANIFEST = {
  schema: "ax.daeb-v2-1-route-manifest/v1",
  gateway: "openrouter",
  reasoning_effort: "high",
  allow_fallbacks: false,
  provider_fallback: false,
  byok_priority_override: false,
  batch: false,
  data_collection: "allow",
  harnesses: Object.fromEntries(Object.entries(V21_HARNESS_PINS).map(([harness, pin]) => [harness, pin])),
  models: V21_MODELS.map((model) => ({
    requested_model: model,
    canonical_model: V21_ROUTE_POLICIES[model].canonical_model,
    provider_only: [V21_ROUTE_POLICIES[model].provider],
    provider_order: [V21_ROUTE_POLICIES[model].provider],
    data_collection: V21_ROUTE_POLICIES[model].data_collection,
  })),
} as const;

export async function startV21OpenRouterGateway(
  model: V21Model,
  ledgerPath: string,
  apiKey = process.env.AX_EVAL_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
): Promise<RunningOpenRouterGateway & { baseUrl: string; policy: OpenRouterRoutePolicy }> {
  if (!apiKey) throw new Error("V2.1 gateway requires AX_EVAL_OPENROUTER_API_KEY (an isolated OpenRouter workspace key)");
  const policy = v21RoutePolicy(model);
  const gateway = await startOpenRouterGateway({ policy, apiKey, ledgerPath });
  return { ...gateway, baseUrl: "http://127.0.0.1:" + gateway.port + "/v1", policy };
}
