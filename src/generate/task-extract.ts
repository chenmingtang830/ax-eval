/**
 * Oracle extract: given a vendor card + canonical suite, produce ONLY the
 * vendor-specific read-back checks for each suite task (plus a vendor-level
 * base_url/auth guess). This is the one part of pack authoring that
 * genuinely requires vendor knowledge — every other field (prompt, id,
 * title, difficulty) is rendered from the suite by pure code in
 * compose-pack.ts.
 *
 * Each check becomes one OracleSpec entry: either a REST roundtrip (the
 * verifier GETs/POSTs `read_path_template`) or, for vendors whose data
 * plane is only reachable over the Postgres/MySQL wire protocol (no REST
 * query endpoint — e.g. CockroachDB, PlanetScale), a `sql_query` check the
 * verifier runs over a real DB connection. Either way, `assert_field` MUST
 * be a real dotted key path (e.g. "count", "0.email") resolved against the
 * response/row and compared to a literal `expected` — free-text
 * explanations don't resolve to anything and silently fail as `undefined`.
 * Multi-step verification (e.g. "count is 1 AND the error code is X") is
 * modeled as two separate checks, not one compound sentence.
 *
 * Extraction is grounded: the prompt requires WebFetching the vendor's docs,
 * and invokeHarness's requireWebFetch option throws if the reply shows zero
 * WebSearch/WebFetch tool calls, so a training-data-only answer is rejected
 * rather than silently accepted.
 *
 * One LLM call per vendor covering all suite tasks. Deliberately narrow:
 * no prompt rewriting, no code snippets, no "approach" prose — those are
 * either unnecessary (the agent discovers them itself) or noise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { Suite } from "./suite.js";

const OracleCheckSchema = z
  .object({
    // REST form.
    read_method: z.enum(["GET", "POST"]).nullish().transform((v) => v ?? undefined),
    read_path_template: z.string().nullish().transform((v) => v ?? undefined),
    // SQL wire-protocol form, for vendors with no REST query endpoint.
    sql_dialect: z.enum(["postgres", "mysql"]).nullish().transform((v) => v ?? undefined),
    sql_query: z.string().nullish().transform((v) => v ?? undefined),
    // A single dotted key path into the JSON response / result row, e.g.
    // "count", "0.email", "documents.0.total". NOT a sentence.
    assert_field: z.string().min(1),
    // The literal value assert_field must equal. May contain "{ns}".
    expected: z.union([z.string(), z.number(), z.boolean()]),
    description: z.string().default(""),
  })
  .refine((c) => Boolean(c.read_path_template) !== Boolean(c.sql_query), {
    message: "check must set exactly one of read_path_template or sql_query",
  });
export type OracleCheck = z.infer<typeof OracleCheckSchema>;

const OracleExtractItemSchema = z.object({
  task_id: z.string(),
  na: z.boolean(),
  na_reason: z.string().nullish().transform((v) => v ?? undefined),
  checks: z.array(OracleCheckSchema).default([]),
});
export type OracleExtractItem = z.infer<typeof OracleExtractItemSchema>;

const VendorConfigSchema = z.object({
  base_url: z.string(),
  auth_type: z.enum(["bearer", "api-key", "oauth", "none"]),
  auth_header: z.string().nullish().transform((v) => v ?? undefined),
  auth_env: z.string(),
  // Set when the same credential must ALSO be sent under a second header
  // name — e.g. Supabase's PostgREST rejects `Authorization: Bearer <key>`
  // alone with "No API key found in request" unless `apikey: <key>` is
  // also present.
  extra_auth_header: z.string().nullish().transform((v) => v ?? undefined),
  // Set when the vendor's data plane requires a raw DB connection (no REST
  // query endpoint) — e.g. CockroachDB, PlanetScale.
  sql_dialect: z.enum(["postgres", "mysql"]).nullish().transform((v) => v ?? undefined),
  sql_connection_env: z.string().nullish().transform((v) => v ?? undefined),
});

const OracleExtractResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  suite_name: z.string(),
  extracted_at: z.string(),
  vendor_config: VendorConfigSchema,
  tasks: z.array(OracleExtractItemSchema),
});
export type OracleExtractResult = z.infer<typeof OracleExtractResultSchema>;

function buildExtractPrompt(vendor: ResolveResult, suite: Suite): string {
  const taskList = suite.tasks
    .map(
      (t, i) =>
        `  ${i + 1}. id="${t.id}" — ${t.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    )
    .join("\n");

  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `Before answering, WebFetch ${vendor.docs_url} (and follow at least one linked API/REST reference page from`,
    `it if the root page doesn't show endpoint details). You MUST ground every answer below in what you actually`,
    `read on those pages — do not answer from memory/training knowledge alone. If you cannot find a definitive`,
    `answer for a task after fetching the docs, say so via na=true rather than guessing.`,
    ``,
    `For each task below, give the read-back call(s) that verify the described state:`,
    `- PREFER REST: if ${vendor.vendor} exposes ANY REST/HTTP endpoint that can run the query (including a`,
    `  PostgREST-style data API, a management/admin API, or a Data API), use read_method + read_path_template.`,
    `  A REST check needs no extra credential beyond the API token already in vendor_config — always prefer it`,
    `  when available.`,
    `- ONLY fall back to sql_dialect + sql_query when ${vendor.vendor}'s data plane is reachable EXCLUSIVELY over`,
    `  the raw Postgres or MySQL wire protocol, with NO REST query/SQL-execution endpoint at all (true for some`,
    `  wire-protocol-native databases). This still counts as verifiable — do NOT mark the task na=true just`,
    `  because there's no REST path; only use na=true when NEITHER REST NOR SQL can express the check (e.g. the`,
    `  vendor has no row-level access-control mechanism at all, or no foreign-key enforcement at all).`,
    `Use {ns} as a literal placeholder for a namespace token embedded in resource names.`,
    ``,
    taskList,
    ``,
    `Each check is ONE machine-checkable assertion:`,
    `- assert_field: a SHORT DOTTED KEY PATH into the JSON response or SQL result row — e.g. "count",`,
    `  "0.email", "documents.0.total". NEVER a sentence or explanation.`,
    `- expected: the literal value assert_field must equal (a number, string, or boolean — taken directly`,
    `  from the task's stated expectation, e.g. 100, 11, 1, true)`,
    `- description: one short phrase for a human reviewer (optional)`,
    `If a task needs more than one assertion (e.g. "row count is 1" AND "error code is X"), emit two separate`,
    `check objects, not one compound sentence.`,
    ``,
    `Also give the vendor's REST API base_url and auth scheme (auth_type: bearer|api-key|oauth|none, auth_header`,
    `if not the default, auth_env: a SCREAMING_SNAKE_CASE env var name). If the vendor's REST API requires the`,
    `SAME credential sent under a SECOND header name too (e.g. Supabase's PostgREST needs both`,
    `"Authorization: Bearer <key>" AND "apikey: <key>" — check the docs for this), set extra_auth_header to that`,
    `second header name; otherwise null. If any check above uses sql_query, also give sql_dialect (postgres|mysql)`,
    `and sql_connection_env (a SCREAMING_SNAKE_CASE env var name for a full connection string) at the`,
    `vendor_config level.`,
    ``,
    `If the vendor's REST API host is per-account (e.g. Supabase's https://<project-ref>.supabase.co, Turso's`,
    `per-database subdomain), write base_url and any read_path_template using \${ENV_VAR_NAME} syntax for the`,
    `per-account part — e.g. "https://\${SUPABASE_PROJECT_REF}.supabase.co" — NOT a bare {placeholder}. Pick a`,
    `SCREAMING_SNAKE_CASE env var name that plausibly matches this project's .env convention (prefixed with the`,
    `vendor name, e.g. SUPABASE_PROJECT_REF, NEON_PROJECT_ID).`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{`,
    `  "vendor_config": {"base_url": "...", "auth_type": "...", "auth_header": "..." or null, "auth_env": "...",`,
    `    "extra_auth_header": "..." or null, "sql_dialect": "postgres"|"mysql"|null, "sql_connection_env": "..." or null},`,
    `  "tasks": [`,
    `    {"task_id": "...", "na": false, "na_reason": null, "checks": [`,
    `      {"read_method": "GET", "read_path_template": "...", "assert_field": "count", "expected": 100, "description": "..."},`,
    `      {"sql_dialect": "postgres", "sql_query": "SELECT ...", "assert_field": "count", "expected": 100, "description": "..."}`,
    `    ]},`,
    `    ...`,
    `  ]`,
    `}`,
    `Include all ${suite.tasks.length} task ids.`,
  ].join("\n");
}

export interface ExtractOraclesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Extract oracle read-back checks + vendor config for a single vendor. */
export async function extractOracles(
  vendor: ResolveResult,
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<OracleExtractResult> {
  const harness = opts.harness ?? "claude-code";
  const prompt = buildExtractPrompt(vendor, suite);
  const raw = await invokeHarness(prompt, {
    harness,
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label: vendor.vendor },
    // This prompt asks for grounded research + a fairly large structured
    // JSON return across all 10 suite tasks — slower than a typical call.
    timeoutMs: 10 * 60 * 1000,
  });
  const json = extractJsonObject(raw);
  const parsed = z
    .object({ vendor_config: VendorConfigSchema, tasks: z.array(OracleExtractItemSchema) })
    .safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `oracle-extract for "${vendor.vendor}" returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const suiteIds = new Set(suite.tasks.map((t) => t.id));
  const returnedIds = new Set(parsed.data.tasks.map((t) => t.task_id));
  const missing = [...suiteIds].filter((id) => !returnedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`oracle-extract for "${vendor.vendor}" missing task IDs: ${missing.join(", ")}`);
  }
  return OracleExtractResultSchema.parse({
    vendor: vendor.vendor,
    category: vendor.category,
    slug: vendor.slug,
    suite_name: suite.name,
    extracted_at: new Date().toISOString(),
    vendor_config: parsed.data.vendor_config,
    tasks: parsed.data.tasks,
  });
}

/** One vendor's extraction outcome — success or the error it failed with. */
export type ExtractOutcome =
  | { vendor: string; ok: true; result: OracleExtractResult }
  | { vendor: string; ok: false; error: string };

/** Extract oracles for multiple vendors in parallel. One vendor's failure
 *  (e.g. malformed LLM JSON) does not lose the other vendors' results —
 *  each runs an independent, expensive LLM call. */
export async function extractOraclesAll(
  vendors: ResolveResult[],
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<ExtractOutcome[]> {
  const settled = await Promise.allSettled(vendors.map((v) => extractOracles(v, suite, opts)));
  return settled.map((s, i) => {
    const vendor = vendors[i]!.vendor;
    return s.status === "fulfilled"
      ? { vendor, ok: true as const, result: s.value }
      : { vendor, ok: false as const, error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
  });
}

/** Path where an oracle-extract result is persisted. */
export function oracleExtractPath(root: string, slug: string, suiteName: string): string {
  return resolve(root, "targets", "extracts", slug, `${suiteName.toLowerCase()}.yaml`);
}

/** Write an oracle-extract to disk as YAML. */
export function writeOracleExtract(root: string, result: OracleExtractResult): string {
  const path = oracleExtractPath(root, result.slug, result.suite_name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

/** Load a previously-written oracle-extract. */
export function loadOracleExtract(root: string, slug: string, suiteName: string): OracleExtractResult | null {
  const path = oracleExtractPath(root, slug, suiteName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = OracleExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`oracle-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
