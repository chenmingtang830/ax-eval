#!/usr/bin/env node
/** No-write provider-pinning attestation for admission into the five-vendor core. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { startOpenRouterGateway, type OpenRouterRoutePolicy } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });
const model = process.env.DAEB_V24_PREFLIGHT_MODEL?.trim();
const provider = process.env.DAEB_V24_PREFLIGHT_PROVIDER?.trim();
const output = resolve(ROOT, process.env.DAEB_V24_PREFLIGHT_OUTPUT
  ?? `results/v24-preflight-${new Date().toISOString().replace(/[:.]/g, "-")}`);
if (!model || !provider) throw new Error("DAEB_V24_PREFLIGHT_MODEL and DAEB_V24_PREFLIGHT_PROVIDER are required");
const apiKey = process.env.AX_EVAL_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OpenRouter key is required for preflight");
const policy: OpenRouterRoutePolicy = { model, canonical_model: model, provider, data_collection: "allow" };
mkdirSync(output, { recursive: true, mode: 0o700 });
const ledger = resolve(output, "route-ledger.jsonl");
const gateway = await startOpenRouterGateway({ policy, apiKey, ledgerPath: ledger });
let response: Response | null = null;
let body = "";
try {
  response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ax-eval-local-gateway" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with ROUTE_OK only." }] }),
  });
  body = await response.text();
} finally {
  await gateway.close();
}
const entries = readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const route = entries.at(-1) ?? null;
const attested = response?.ok === true && route?.outcome === "ok";
const result = {
  schema: "ax.daeb-v2-4-provider-preflight/v1", formal: false, no_write: true,
  model, provider, status: response?.status ?? null, attested, route,
  response_excerpt: body.slice(0, 500),
  decision: attested ? "provider-pinned-admitted" : "not-admitted",
};
writeFileSync(resolve(output, "preflight.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output, model, provider, status: result.status, attested, decision: result.decision }, null, 2));
process.exitCode = attested ? 0 : 2;
