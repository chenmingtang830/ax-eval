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
 * Extraction is grounded: every prompt requires WebFetching the vendor's
 * docs, and invokeHarness's requireWebFetch option throws if the reply
 * shows zero WebSearch/WebFetch tool calls, so a training-data-only answer
 * is rejected rather than silently accepted.
 *
 * DECOMPOSED per (vendor, task) — NOT one call covering all 10 tasks.
 * The 10 suite tasks touch unrelated doc pages (schema DDL, RLS/auth,
 * constraints, migrations, edge functions, backups, ...), so a single
 * linear conversation asking for all of them serialized 10+ WebFetch
 * round-trips into one call — measured at up to ~26 minutes for one
 * vendor. Splitting into one small call per task lets those WebFetches
 * run concurrently instead of sequentially in one conversation; a vendor's
 * wall-clock time drops to roughly the slowest SINGLE task, not the sum.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { Suite, SuiteTask } from "./suite.js";

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

const CHECK_FORMAT_RULES = [
  `Each check is ONE machine-checkable assertion:`,
  `- assert_field: a SHORT DOTTED KEY PATH into the JSON response or SQL result row — e.g. "count",`,
  `  "0.email", "documents.0.total". NEVER a sentence or explanation.`,
  `- expected: the literal value assert_field must equal (a number, string, or boolean — taken directly`,
  `  from the task's stated expectation, e.g. 100, 11, 1, true)`,
  `- description: one short phrase for a human reviewer (optional)`,
  `If the task needs more than one assertion (e.g. "row count is 1" AND "error code is X"), emit two`,
  `separate check objects, not one compound sentence.`,
].join("\n");

function buildTaskPrompt(vendor: ResolveResult, task: SuiteTask): string {
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `Before answering, WebFetch ${vendor.docs_url} (or a more specific linked page if the root page doesn't`,
    `show what you need — e.g. a dedicated guide for this feature). You MUST ground your answer in what you`,
    `actually read on those pages — do not answer from memory/training knowledge alone. If you cannot find a`,
    `definitive answer after fetching the docs, say so via na=true rather than guessing.`,
    ``,
    `Task: ${task.id} — ${task.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    ``,
    `Give the read-back call(s) that verify the described state:`,
    `- PREFER REST: if ${vendor.vendor} exposes ANY REST/HTTP endpoint that can run the query (including a`,
    `  PostgREST-style data API, a management/admin API, or a Data API), use read_method + read_path_template.`,
    `  A REST check needs no extra credential beyond the vendor's normal API token — always prefer it when`,
    `  available.`,
    `- ONLY fall back to sql_dialect + sql_query when ${vendor.vendor}'s data plane is reachable EXCLUSIVELY`,
    `  over the raw Postgres or MySQL wire protocol, with NO REST query/SQL-execution endpoint at all. This`,
    `  still counts as verifiable — do NOT set na=true just because there's no REST path; only use na=true`,
    `  when NEITHER REST NOR SQL can express the check (e.g. the vendor has no row-level access-control`,
    `  mechanism at all, or no foreign-key enforcement at all).`,
    `Use {ns} as a literal placeholder for a namespace token embedded in resource names. If the API host is`,
    `per-account (e.g. https://<project-ref>.example.com), write the path using \${ENV_VAR_NAME} syntax for`,
    `the per-account part instead of a bare {placeholder}.`,
    ``,
    CHECK_FORMAT_RULES,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"task_id": "${task.id}", "na": false, "na_reason": null, "checks": [`,
    `  {"read_method": "GET", "read_path_template": "...", "assert_field": "count", "expected": 100, "description": "..."}`,
    `]}`,
  ].join("\n");
}

function buildVendorConfigPrompt(vendor: ResolveResult): string {
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `Before answering, WebFetch ${vendor.docs_url} (and its API/auth reference page if the root page doesn't`,
    `show this) to find the vendor's REST API base_url and auth scheme. Ground your answer in what you`,
    `actually read — do not answer from memory alone.`,
    ``,
    `Give:`,
    `- base_url: the REST API root, e.g. "https://api.example.com" or, for per-account hosts, using`,
    `  \${ENV_VAR_NAME} syntax for the per-account part, e.g. "https://\${SUPABASE_PROJECT_REF}.supabase.co"`,
    `  (pick a SCREAMING_SNAKE_CASE env var name prefixed with the vendor name)`,
    `- auth_type: bearer|api-key|oauth|none, and auth_header if not the default`,
    `- auth_env: a SCREAMING_SNAKE_CASE env var name for the credential`,
    `- extra_auth_header: if the REST API requires the SAME credential sent under a SECOND header name too`,
    `  (e.g. Supabase's PostgREST needs both "Authorization: Bearer <key>" AND "apikey: <key>"), the second`,
    `  header name; otherwise null`,
    `- sql_dialect + sql_connection_env: ONLY if ${vendor.vendor}'s data plane is reachable exclusively over`,
    `  the raw Postgres or MySQL wire protocol (no REST query endpoint) — sql_connection_env is a`,
    `  SCREAMING_SNAKE_CASE env var name for a full connection string; otherwise both null`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"base_url": "...", "auth_type": "...", "auth_header": null, "auth_env": "...", "extra_auth_header": null,`,
    ` "sql_dialect": null, "sql_connection_env": null}`,
  ].join("\n");
}

export interface ExtractOraclesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

// Grounded single-topic research call. Measured at well under a minute for
// a focused one-task/one-topic question (vs. up to ~26min for the old
// one-call-covers-everything design) — still generous given network variance.
const PER_CALL_TIMEOUT_MS = 8 * 60 * 1000;

async function extractTaskCheck(
  vendor: ResolveResult,
  task: SuiteTask,
  opts: ExtractOraclesOptions,
): Promise<OracleExtractItem> {
  const raw = await invokeHarness(buildTaskPrompt(vendor, task), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label: `${vendor.vendor}/${task.id}` },
    timeoutMs: PER_CALL_TIMEOUT_MS,
  });
  const parsed = OracleExtractItemSchema.safeParse(JSON.parse(extractJsonObject(raw)));
  if (!parsed.success) {
    throw new Error(
      `oracle-extract for "${vendor.vendor}"/${task.id} returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  if (parsed.data.task_id !== task.id) {
    throw new Error(`oracle-extract for "${vendor.vendor}" returned task_id "${parsed.data.task_id}", expected "${task.id}"`);
  }
  return parsed.data;
}

async function extractVendorConfig(
  vendor: ResolveResult,
  opts: ExtractOraclesOptions,
): Promise<z.infer<typeof VendorConfigSchema>> {
  const raw = await invokeHarness(buildVendorConfigPrompt(vendor), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label: `${vendor.vendor}/vendor_config` },
    timeoutMs: PER_CALL_TIMEOUT_MS,
  });
  const parsed = VendorConfigSchema.safeParse(JSON.parse(extractJsonObject(raw)));
  if (!parsed.success) {
    throw new Error(
      `oracle-extract vendor_config for "${vendor.vendor}" returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/** Extract oracle read-back checks + vendor config for a single vendor.
 *  Runs one small grounded call per suite task PLUS one for vendor config,
 *  all in parallel — see module docstring for why this replaced a single
 *  monolithic per-vendor call. */
export async function extractOracles(
  vendor: ResolveResult,
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<OracleExtractResult> {
  const [vendorConfig, ...tasks] = await Promise.all([
    extractVendorConfig(vendor, opts),
    ...suite.tasks.map((t) => extractTaskCheck(vendor, t, opts)),
  ]);
  return OracleExtractResultSchema.parse({
    vendor: vendor.vendor,
    category: vendor.category,
    slug: vendor.slug,
    suite_name: suite.name,
    extracted_at: new Date().toISOString(),
    vendor_config: vendorConfig,
    tasks,
  });
}

/** One vendor's extraction outcome — success or the error it failed with. */
export type ExtractOutcome =
  | { vendor: string; ok: true; result: OracleExtractResult }
  | { vendor: string; ok: false; error: string };

/** Extract oracles for multiple vendors in parallel. One vendor's failure
 *  (e.g. malformed LLM JSON) does not lose the other vendors' results —
 *  each runs independent, real LLM calls. */
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
