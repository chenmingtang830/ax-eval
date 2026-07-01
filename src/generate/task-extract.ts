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

// Models reliably reach for "postgresql" (the more common spelling) despite
// the prompt/schema calling for "postgres" — normalize instead of retrying
// on a mistake that isn't going to stop happening.
const SqlDialectSchema = z.preprocess(
  (v) => (v === "postgresql" ? "postgres" : v),
  z.enum(["postgres", "mysql"]),
);

const OracleCheckSchema = z
  .object({
    // REST form.
    read_method: z.enum(["GET", "POST"]).nullish().transform((v) => v ?? undefined),
    read_path_template: z.string().nullish().transform((v) => v ?? undefined),
    // SQL wire-protocol form, for vendors with no REST query endpoint.
    sql_dialect: SqlDialectSchema.nullish().transform((v) => v ?? undefined),
    sql_query: z.string().nullish().transform((v) => v ?? undefined),
    // A single dotted key path into the JSON response / result row, e.g.
    // "count", "0.email", "documents.0.total". NOT a sentence.
    assert_field: z.string().min(1),
    // The literal value assert_field must equal. May contain "{ns}".
    expected: z.union([z.string(), z.number(), z.boolean()]),
    // For identity-scoped (e.g. RLS) checks: the name of a token the agent
    // self-reports (alongside gid) that the verifier uses as THIS check's
    // Bearer credential instead of the pack's default — needed because the
    // pack's admin-level credential typically bypasses row-level security.
    auth_field: z.string().nullish().transform((v) => v ?? undefined),
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
  sql_dialect: SqlDialectSchema.nullish().transform((v) => v ?? undefined),
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
  `- auth_field: omit for normal checks. Set ONLY for identity-scoped checks (see below) to the name of a`,
  `  token the agent will self-report.`,
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
    `Task: ${task.id}`,
    `Intent (defines the EXACT resource names/patterns involved — use them verbatim, do not invent your own):`,
    `  ${task.intent.trim().replace(/\n\s*/g, " ")}`,
    `Oracle hint (what to verify):`,
    `  ${task.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    ``,
    `IMPORTANT — this task is one of TEN run in sequence by an agent; verification happens ONCE, only after`,
    `ALL TEN have finished. Your check must describe a property that is still true in that FINAL, cumulative`,
    `state — never a property that's only true right when THIS task completes and would be invalidated by a`,
    `LATER task (e.g. "the table is empty right after creation" breaks the moment a later task inserts rows`,
    `into it — assert something that survives to the end, like "the table exists with the right columns").`,
    ``,
    `Give the read-back call(s) that verify the described state:`,
    `- ONE credential only: use ${vendor.vendor}'s single data-plane API (the vendor's normal per-project REST`,
    `  API / PostgREST-style data API, or the raw Postgres/MySQL wire protocol) — the same credential type for`,
    `  every check. Do NOT reach for a separate control-plane / management / admin API that would need a`,
    `  DIFFERENT credential (e.g. a personal access token instead of a project API key) — this pack only wires`,
    `  up one credential. If the ONLY way to verify something is through a differently-credentialed`,
    `  control-plane API, set na=true with na_reason explaining that a second credential type would be needed.`,
    `- PREFER REST if the vendor's data-plane REST API can run the query: use read_method + read_path_template.`,
    `- ONLY fall back to sql_dialect + sql_query when ${vendor.vendor}'s data plane is reachable EXCLUSIVELY`,
    `  over the raw Postgres or MySQL wire protocol, with NO REST query endpoint at all. This still counts as`,
    `  verifiable — do NOT set na=true just because there's no REST path; only use na=true when NEITHER REST`,
    `  NOR SQL can express the check (e.g. no row-level access-control mechanism at all).`,
    `- For a row-count assertion, do NOT rely on an aggregate query function (e.g. "count()" in the query`,
    `  string) or a response HEADER (e.g. Content-Range) — aggregates may be disabled on the target project`,
    `  and headers aren't inspected by the verifier. Instead fetch the actual rows (with a limit comfortably`,
    `  above the expected count) and assert on the returned JSON array's length: assert_field "length".`,
    `- read_path_template is the FULL path from the bare per-project host (base_url has NO fixed prefix) — you`,
    `  must include whatever root segment your specific endpoint family needs, e.g. "/rest/v1/..." for a`,
    `  PostgREST-style data API or "/functions/v1/..." for edge functions on that SAME host. Never assume`,
    `  base_url already contains a family prefix.`,
    `- IDENTITY-SCOPED checks (e.g. row-level access control / "only the owner can see their own row"): the`,
    `  pack's one credential is an admin/service-level key that typically BYPASSES row-level security by`,
    `  design, so verifying isolation needs a DIFFERENT, per-identity credential the agent creates during the`,
    `  task — not the pack's normal credential. For these, set "auth_field" on the check to a short name (e.g.`,
    `  "user_a_token") the agent should report a signed-in token under (alongside gid, in its results JSON —`,
    `  the verifier will use THAT reported value as the Bearer credential for this specific check instead of`,
    `  the pack default). Phrase expected values as fixed booleans-of-visibility that don't depend on unknown`,
    `  data volume: e.g. "as user_a_token, GET a specific row → length=1 (owner sees it)" and "as`,
    `  user_b_token, GET the SAME row → length=0 (a different identity does not)" — two checks, one per`,
    `  identity. Which row to check: if THIS task's own action naturally creates/returns that specific row,`,
    `  use {gid} for it. If the task's primary action is something else (e.g. it configures a policy, not a`,
    `  row) and the row to test needs to be a SEPARATE thing the agent identifies, invent a named field for`,
    `  it too (see below) instead of assuming {gid} is that row.`,
    ``,
    `Placeholders:`,
    `- {ns}: a namespace token. Use it EXACTLY as it appears in the intent above — if the intent says the`,
    `  table is \`axarena_customers_{ns}\`, your read_path_template/sql_query must reference the FULL name`,
    `  \`axarena_customers_{ns}\`, never a bare {ns} alone. Do not abbreviate or restructure the resource name.`,
    `- {gid}: the identifier the AGENT self-reports as THIS task's primary created/configured thing (e.g. a`,
    `  table name, policy name — whatever the task's own action most directly produces). Use {gid} only when`,
    `  your check is about THAT thing AND {gid} is directly usable in your URL/query as-is.`,
    `- CAUTION for deploy/invoke-type tasks (e.g. a function, a job): the agent may report an internal/opaque`,
    `  id under gid (a deployment id, an invocation id) that is NOT the externally-addressable name/slug`,
    `  needed to actually call the resource via URL. If your check needs to ADDRESS the resource (e.g. GET`,
    `  /functions/v1/<name>), don't assume {gid} is that address — use a named field instead (e.g.`,
    `  {function_slug}) and let the agent report the actual invokable name/slug under that key.`,
    `- Any other descriptive {snake_case_name} (e.g. {test_row_id}, {duplicate_email}, {function_slug}): use`,
    `  this whenever your check needs a SPECIFIC value that {gid} doesn't already cover, or that {gid} covers`,
    `  ambiguously (see above), and no literal from the intent text provides it. The agent will be told to`,
    `  report it as an extra key in its results JSON, the same way auth_field tokens are reported. Don't`,
    `  invent one when {gid} unambiguously already works.`,
    `If the API host is per-account (e.g. https://<project-ref>.example.com), write it using \${ENV_VAR_NAME}`,
    `syntax for the per-account part instead of a bare {placeholder}.`,
    ``,
    CHECK_FORMAT_RULES,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"task_id": "${task.id}", "na": false, "na_reason": null, "checks": [`,
    `  {"read_method": "GET", "read_path_template": "/rest/v1/...", "assert_field": "length", "expected": 100, "description": "..."}`,
    `]}`,
    `(identity-scoped example using a named field for the row under test, since this task's own gid is a`,
    `policy name, not a row: {"read_method": "GET", "read_path_template":`,
    `"/rest/v1/axarena_customers_{ns}?id=eq.{test_row_id}", "auth_field": "user_a_token", "assert_field":`,
    `"length", "expected": 1, "description": "owner sees their row"})`,
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
    `- base_url: the BARE per-project host, with NO fixed path segment (no "/rest/v1", no "/v1", nothing) —`,
    `  e.g. "https://\${SUPABASE_PROJECT_REF}.supabase.co", NOT "https://\${SUPABASE_PROJECT_REF}.supabase.co/rest/v1".`,
    `  Individual checks (extracted separately, one per task) each write their OWN full path from this bare`,
    `  host, including whatever root segment their specific endpoint family needs (a data-plane REST API might`,
    `  live under one path prefix while a functions/edge-function API lives under a different one on the SAME`,
    `  host) — so base_url must NOT already bake in a family-specific prefix, or paths get double-prefixed.`,
    `  Use the vendor's per-project DATA-PLANE host — NOT a separate control-plane/management/admin host`,
    `  (those typically need a different credential type, like a personal access token instead of a project`,
    `  API key, which this pack does not wire up). For per-account hosts, use \${ENV_VAR_NAME} syntax for the`,
    `  per-account part (pick a SCREAMING_SNAKE_CASE env var name prefixed with the vendor name)`,
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

// A model sometimes answers an "easy" task from general knowledge instead of
// grounding it (requireWebFetch correctly rejects this) — often nondeterministic,
// so one retry recovers most of these without discarding 10 already-successful
// sibling calls over a single flaky one.
const MAX_ATTEMPTS = 2;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        process.stderr.write(`  [${label}] attempt ${attempt} failed, retrying: ${err instanceof Error ? err.message.split("\n")[0] : err}\n`);
      }
    }
  }
  throw lastErr;
}

async function extractTaskCheck(
  vendor: ResolveResult,
  task: SuiteTask,
  opts: ExtractOraclesOptions,
): Promise<OracleExtractItem> {
  const label = `${vendor.vendor}/${task.id}`;
  return withRetry(label, async () => {
    const raw = await invokeHarness(buildTaskPrompt(vendor, task), {
      harness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      requireWebFetch: true,
      heartbeat: { everyMs: 30_000, label },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    });
    const json = extractJsonObject(raw);
    const parsed = OracleExtractItemSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      throw new Error(`oracle-extract for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
    }
    if (parsed.data.task_id !== task.id) {
      throw new Error(`oracle-extract for "${vendor.vendor}" returned task_id "${parsed.data.task_id}", expected "${task.id}"`);
    }
    return parsed.data;
  });
}

async function extractVendorConfig(
  vendor: ResolveResult,
  opts: ExtractOraclesOptions,
): Promise<z.infer<typeof VendorConfigSchema>> {
  const label = `${vendor.vendor}/vendor_config`;
  return withRetry(label, async () => {
    const raw = await invokeHarness(buildVendorConfigPrompt(vendor), {
      harness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      requireWebFetch: true,
      heartbeat: { everyMs: 30_000, label },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    });
    const json = extractJsonObject(raw);
    const parsed = VendorConfigSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      throw new Error(`oracle-extract vendor_config for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
    }
    return parsed.data;
  });
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
