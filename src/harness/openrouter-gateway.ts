import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface OpenRouterRoutePolicy {
  model: string;
  provider: string;
  /** Immutable canonical slug recorded by the preflight manifest. */
  canonical_model: string;
  /** Explicit OpenRouter data policy; omitted for generic callers. */
  data_collection?: "allow" | "deny";
}

export interface OpenRouterRouteLedgerEntry {
  schema: "ax.openrouter-route-ledger/v1";
  at: string;
  request_id: string | null;
  requested_model: string | null;
  canonical_model: string;
  required_provider: string;
  resolved_provider: string | null;
  generation_id: string | null;
  status: number;
  outcome: "ok" | "upstream-error" | "invalid-route" | "invalid-request";
  cost_usd: number | null;
  token_usage: Record<string, number> | null;
  time_to_first_byte_ms: number | null;
  duration_ms: number;
}

export interface OpenRouterRouteEvidence {
  resolved_provider: string | null;
  generation_id: string | null;
  cost_usd: number | null;
  token_usage: Record<string, number> | null;
}

export function enforceOpenRouterRequest(
  body: Record<string, unknown>,
  policy: OpenRouterRoutePolicy,
): Record<string, unknown> {
  const requested = body.model;
  if (requested !== undefined && requested !== policy.model && requested !== policy.canonical_model) {
    throw new Error(`model route mismatch: expected ${policy.model}, got ${String(requested)}`);
  }
  const normalizedBody = { ...body };
  // Some OpenRouter provider adapters reject the newer OpenAI field while
  // accepting the equivalent legacy field. Normalize at the controller edge
  // so a pinned provider does not become an accidental harness-compatibility
  // failure; the requested budget remains unchanged.
  if (normalizedBody.max_completion_tokens !== undefined && normalizedBody.max_tokens === undefined) {
    normalizedBody.max_tokens = normalizedBody.max_completion_tokens;
    delete normalizedBody.max_completion_tokens;
  }
  return {
    ...normalizedBody,
    model: policy.model,
    provider: {
      ...(typeof body.provider === "object" && body.provider !== null ? body.provider : {}),
      only: [policy.provider],
      order: [policy.provider],
      allow_fallbacks: false,
      require_parameters: true,
      ...(policy.data_collection ? { data_collection: policy.data_collection } : {}),
    },
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageFrom(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]) {
    const amount = numberOrNull(source[key]);
    if (amount !== null) usage[key] = amount;
  }
  return Object.keys(usage).length ? usage : null;
}

export function routeEvidenceFromResponse(
  headers: Headers,
  payload?: Record<string, unknown> | null,
): OpenRouterRouteEvidence {
  const usage = usageFrom(payload?.usage);
  const cost = numberOrNull(payload?.cost) ?? numberOrNull((payload?.usage as Record<string, unknown> | undefined)?.cost);
  const provider = headers.get("x-openrouter-provider")
    ?? headers.get("x-provider")
    ?? (typeof payload?.provider === "string" ? payload.provider : null);
  const generation = headers.get("x-openrouter-generation-id")
    ?? headers.get("x-generation-id")
    ?? (typeof payload?.generation_id === "string" ? payload.generation_id : null)
    ?? (typeof payload?.id === "string" ? payload.id : null);
  return { resolved_provider: provider, generation_id: generation, cost_usd: cost, token_usage: usage };
}

function streamingPayload(raw: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("data:")) continue;
    const data = value.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") last = parsed;
    } catch {
      /* Ignore non-JSON SSE comments; the attestation remains fail-closed. */
    }
  }
  return last;
}

async function readResponseBody(response: Response): Promise<{ raw: string; firstByte: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { raw: await response.text(), firstByte: performance.now() };
  const chunks: Uint8Array[] = [];
  let firstByte = performance.now();
  let seen = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!seen) {
        firstByte = performance.now();
        seen = true;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { raw: new TextDecoder().decode(bytes), firstByte };
}

export function validateResolvedProvider(evidence: OpenRouterRouteEvidence, requiredProvider: string): boolean {
  if (!evidence.resolved_provider) return false;
  // OpenRouter sometimes attests a display name (for example `Z.AI`) while
  // request routing requires the provider id (`z-ai`). Treat punctuation
  // differences as equivalent, but keep the comparison anchored so a
  // different provider cannot pass the fail-closed route gate.
  const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const normalized = canonical(evidence.resolved_provider);
  const required = canonical(requiredProvider);
  if (normalized === required || normalized.startsWith(`${required}-`)) return true;
  // Provider attestations are not consistent about whether the display name
  // keeps the provider's word boundaries (for example `Moonshot AI` versus
  // `moonshotai`, or `xAI` versus `xai`). Compare a compact form as well while
  // retaining the anchored exact/ prefix checks above.
  const compact = (value: string) => value.replace(/-/g, "");
  if (compact(normalized) === compact(required)) return true;
  // OpenRouter may attest the Google Vertex endpoint with the display label
  // `Google` instead of the request slug `google-vertex`. Accept this one
  // anchored alias only; all other providers remain fail-closed.
  return required === "google-vertex" && normalized === "google";
}

export interface OpenRouterGatewayOptions {
  policy: OpenRouterRoutePolicy;
  apiKey: string;
  ledgerPath: string;
  upstream?: string;
  fetchImpl?: typeof fetch;
}

export interface RunningOpenRouterGateway {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; if (body.length > 20 * 1024 * 1024) reject(new Error("request too large")); });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

/** Start a local enforcement gateway. It intentionally binds to loopback only. */
export async function startOpenRouterGateway(options: OpenRouterGatewayOptions): Promise<RunningOpenRouterGateway> {
  if (!options.apiKey) throw new Error("OpenRouter gateway requires an API key");
  mkdirSync(dirname(options.ledgerPath), { recursive: true, mode: 0o700 });
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = options.upstream ?? "https://openrouter.ai/api/v1";
  const server = createServer(async (request, response) => {
    const started = performance.now();
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch {
      appendLedger(options.ledgerPath, makeLedger(options.policy, requestId, null, 400, "invalid-request", started, null, null));
      writeJson(response, 400, { error: { message: "invalid JSON" } });
      return;
    }
    let enforced: Record<string, unknown>;
    try {
      enforced = enforceOpenRouterRequest(body, options.policy);
    } catch (error) {
      appendLedger(options.ledgerPath, makeLedger(options.policy, requestId, null, 400, "invalid-request", started, null, typeof body.model === "string" ? body.model : null));
      writeJson(response, 400, { error: { message: String(error) } });
      return;
    }
    const requestPath = request.url?.startsWith("/") ? request.url : `/${request.url ?? "v1/chat/completions"}`;
    const normalizedUpstream = upstream.replace(/\/$/, "");
    const url = normalizedUpstream.endsWith("/v1") && requestPath.startsWith("/v1/")
      ? `${normalizedUpstream}${requestPath.slice(3)}`
      : `${normalizedUpstream}${requestPath}`;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImpl(url, {
        method: request.method ?? "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, "x-request-id": requestId },
        body: JSON.stringify(enforced),
      });
    } catch {
      appendLedger(options.ledgerPath, makeLedger(options.policy, requestId, null, 599, "upstream-error", started, null));
      writeJson(response, 502, { error: { message: "upstream unavailable" } });
      return;
    }
    const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
    const { raw, firstByte } = await readResponseBody(upstreamResponse);
    let payload: Record<string, unknown> | null = null;
    try {
      payload = contentType.includes("event-stream")
        ? streamingPayload(raw)
        : JSON.parse(raw) as Record<string, unknown>;
    } catch { payload = null; }
    const evidence = routeEvidenceFromResponse(upstreamResponse.headers, payload);
    const validRoute = validateResolvedProvider(evidence, options.policy.provider);
    const outcome = !upstreamResponse.ok
      ? "upstream-error"
      : validRoute ? "ok" : "invalid-route";
    appendLedger(options.ledgerPath, makeLedger(options.policy, requestId, evidence, upstreamResponse.status, outcome, started, firstByte, typeof body.model === "string" ? body.model : null));
    response.statusCode = validRoute || !upstreamResponse.ok ? upstreamResponse.status : 502;
    response.setHeader("content-type", contentType);
    response.end(validRoute || !upstreamResponse.ok ? raw : JSON.stringify({ error: { message: "resolved provider was not attested" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind to a TCP port");
  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function makeLedger(
  policy: OpenRouterRoutePolicy,
  requestId: string | null,
  evidence: OpenRouterRouteEvidence | null,
  status: number,
  outcome: OpenRouterRouteLedgerEntry["outcome"],
  started: number,
  firstByte: number | null,
  requestedModel: string | null = policy.model,
): OpenRouterRouteLedgerEntry {
  return {
    schema: "ax.openrouter-route-ledger/v1",
    at: new Date().toISOString(),
    request_id: requestId,
    requested_model: requestedModel,
    canonical_model: policy.canonical_model,
    required_provider: policy.provider,
    resolved_provider: evidence?.resolved_provider ?? null,
    generation_id: evidence?.generation_id ?? null,
    status,
    outcome,
    cost_usd: evidence?.cost_usd ?? null,
    token_usage: evidence?.token_usage ?? null,
    time_to_first_byte_ms: firstByte === null ? null : Math.round(firstByte - started),
    duration_ms: Math.round(performance.now() - started),
  };
}

function appendLedger(path: string, entry: OpenRouterRouteLedgerEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
