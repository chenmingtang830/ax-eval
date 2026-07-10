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
import type { Effort, HarnessId } from "./harness.js";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import { mapSettledLimit } from "./concurrency.js";
import type { SupportMatrix } from "./methodology.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { Suite, SuiteTask } from "./suite.js";
import { daebOraclesPath } from "./benchmark-paths.js";

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
    read_body_template: z.unknown().optional(),
    // SQL wire-protocol form, for vendors with no REST query endpoint.
    sql_dialect: SqlDialectSchema.nullish().transform((v) => v ?? undefined),
    sql_query: z.string().nullish().transform((v) => v ?? undefined),
    probe_sql_query: z.string().nullish().transform((v) => v ?? undefined),
    probe_assert_field: z.string().nullish().transform((v) => v ?? undefined),
    probe_expected: z.union([z.string(), z.number(), z.boolean()]).nullish().transform((v) => v ?? undefined),
    probe_expect_error: z.boolean().nullish().transform((v) => v ?? undefined),
    mongo_query: z.object({
      database: z.string(),
      collection: z.string(),
      operation: z.enum(["count", "findOne", "aggregate", "listCollections"]),
      filter: z.unknown().optional(),
      projection: z.unknown().optional(),
      sort: z.unknown().optional(),
      pipeline: z.array(z.unknown()).optional(),
    }).optional(),
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
    // SQL variant of auth_field: the name of a full alternate connection
    // string the agent self-reports (alongside gid) — needed when the
    // resource to verify lives behind a DIFFERENT credential than the
    // pack's default sql_conn (e.g. a new branch created during a restore,
    // or a scoped role created for RBAC testing).
    sql_conn_field: z.string().nullish().transform((v) => v ?? undefined),
    description: z.string().default(""),
  })
  .refine((c) => [c.read_path_template, c.sql_query, c.mongo_query].filter(Boolean).length === 1, {
    message: "check must set exactly one of read_path_template, sql_query, or mongo_query",
  });
export type OracleCheck = z.infer<typeof OracleCheckSchema>;

const SurfaceIdSchema = z.enum(["api", "sdk", "cli", "mcp"]);
type ExtractSurfaceId = z.infer<typeof SurfaceIdSchema>;

const OracleExtractItemSchema = z.object({
  task_id: z.string(),
  // True only when NO surface can do this at all for the vendor (rare —
  // e.g. no backup mechanism exists anywhere). Prefer na_surfaces for the
  // much more common case where SOME but not all surfaces support it.
  na: z.boolean(),
  na_reason: z.string().nullish().transform((v) => v ?? undefined),
  // Surfaces where THIS task specifically can't be done, even though other
  // surfaces can (e.g. Supabase's JS SDK has no DDL, so "sdk" is na here
  // even though db-T01 works fine via REST/CLI/MCP). Excluded from that
  // surface's execution and scoring — same "no capability, say so" logic
  // as na/na_reason, just scoped to one surface instead of the whole task.
  na_surfaces: z.array(SurfaceIdSchema).default([]),
  na_surfaces_reason: z.string().nullish().transform((v) => v ?? undefined),
  support_reference: z.string().nullish().transform((v) => v ?? undefined),
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
  mongo_connection_env: z.string().nullish().transform((v) => v ?? undefined),
  mongo_database: z.string().nullish().transform((v) => v ?? undefined),
});
type VendorConfig = z.infer<typeof VendorConfigSchema>;

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
  `Each check is one machine-checkable assertion.`,
  `- assert_field: short dotted key path into JSON or the SQL result row, e.g. "length", "0.email", "count".`,
  `- expected: literal string, number, or boolean.`,
  `- description: short reviewer label.`,
  `- auth_field: only for identity-scoped checks where the agent must report a per-user token.`,
    `- probe_sql_query: optional namespace-scoped verifier SQL probe before the read check; use only for a deterministic conflict/deny assertion.`,
    `- probe_assert_field/probe_expected: assertion over the probe result (error code defaults to "code" when probe_expect_error is true).`,
  `Use multiple checks for multiple assertions.`,
].join("\n");

function buildTaskPrompt(vendor: ResolveResult, task: SuiteTask, fixedSupport?: {
  supportedSurfaces: string[];
  unsupportedSurfaces: string[];
  reference?: string;
}): string {
  return [
    `Author one outcome-verifier adapter for ${vendor.vendor} (${vendor.category}).`,
    `Fetch official docs starting at ${vendor.docs_url}; use a more specific linked page when needed.`,
    `Answer only from fetched docs. If docs do not prove a verifiable path, set na=true with a concise reason.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Intent: ${task.intent.trim().replace(/\n\s*/g, " ")}`,
    `Verifier target: ${task.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    ``,
    `Verification happens once after the full suite, so check durable final state, not transient intermediate state.`,
    `Use one data-plane credential family only. Prefer REST read_method + read_path_template; use sql_dialect + sql_query when the data plane is only SQL wire protocol. If verification needs a separate control-plane credential, mark na=true.`,
    `read_path_template is the full path from a bare base_url and must include any API prefix such as /rest/v1 or /functions/v1.`,
    `For row counts, fetch rows and assert JSON array "length"; do not depend on response headers.`,
    `For identity-scoped checks, set auth_field to a token name the agent must report, then assert visibility with fixed expected lengths.`,
    ``,
    `Placeholders:`,
    `- {ns}: namespace token; preserve the full resource names from the intent, e.g. axarena_items_{ns}.`,
    `- {gid}: the primary identifier the agent reports for this task; use only when directly addressable.`,
    `- {snake_case_name}: use only when the verifier needs another specific value for the agent to report.`,
    `Use \${ENV_VAR_NAME} syntax only for account/project parts of hosts, not task resources.`,
    ``,
    CHECK_FORMAT_RULES,
    ``,
    `Surface support is precomputed; do not re-decide it.`,
    fixedSupport
      ? `Supported surfaces: [${fixedSupport.supportedSurfaces.join(", ")}]. Unsupported surfaces: [${fixedSupport.unsupportedSurfaces.join(", ")}].`
      : `If no support matrix is provided, leave na_surfaces empty unless the docs make a surface exclusion explicit.`,
    fixedSupport?.reference
      ? `Set support_reference to "${fixedSupport.reference}" and do not invent a different support decision.`
      : `support_reference may be null when no support matrix entry was supplied.`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"task_id":"${task.id}","na":false,"na_reason":null,"na_surfaces":[],"na_surfaces_reason":null,"support_reference":null,"checks":[{"read_method":"GET","read_path_template":"/rest/v1/...","assert_field":"length","expected":1,"description":"..."}]}`,
  ].join("\n");
}

function buildVendorConfigPrompt(vendor: ResolveResult): string {
  return [
    `Author the vendor config for ${vendor.vendor} (${vendor.category}).`,
    `Fetch official docs starting at ${vendor.docs_url}; use an API/auth reference page if needed.`,
    `Answer only from fetched docs.`,
    ``,
    `Return the data-plane connection used by task verifier checks:`,
    `- base_url: bare per-project host with no fixed path segment; checks add /rest/v1, /v1, etc.`,
    `- use the product data-plane host, not a separately credentialed management host.`,
    `- auth_type: bearer|api-key|oauth|none; set auth_header only when non-default.`,
    `- auth_env: SCREAMING_SNAKE_CASE credential env var.`,
    `- extra_auth_header: same credential under a second header name, or null.`,
    `- sql_dialect/sql_connection_env: only when the data plane is exclusively Postgres/MySQL wire protocol.`,
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
  supportMatrix?: SupportMatrix;
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
const PER_VENDOR_TASK_CONCURRENCY = 3;
const VENDOR_EXTRACTION_CONCURRENCY = 2;

function seedVendorConfig(vendor: ResolveResult): VendorConfig | null {
  switch (vendor.slug) {
    case "supabase":
      return VendorConfigSchema.parse({
        base_url: "https://${SUPABASE_PROJECT_REF}.supabase.co",
        auth_type: "bearer",
        auth_env: "SUPABASE_API_KEY",
        extra_auth_header: "apikey",
        sql_dialect: "postgres",
        sql_connection_env: "SUPABASE_DB_URL",
      });
    case "neon":
      return VendorConfigSchema.parse({
        base_url: "https://console.neon.tech/api/v2",
        auth_type: "bearer",
        auth_header: "Authorization",
        auth_env: "NEON_API_KEY",
        sql_dialect: "postgres",
        sql_connection_env: "NEON_DATABASE_URL",
      });
    case "cockroachdb":
      return VendorConfigSchema.parse({
        base_url: "https://cockroachlabs.cloud/api/v1",
        auth_type: "bearer",
        auth_env: "COCKROACH_API_KEY",
        sql_dialect: "postgres",
        sql_connection_env: "COCKROACH_CONNECTION_STRING",
      });
    case "insforge":
      return VendorConfigSchema.parse({
        base_url: "${INSFORGE_PROJECT_URL}",
        auth_type: "bearer",
        auth_env: "INSFORGE_API_KEY",
        sql_dialect: "postgres",
        sql_connection_env: "INSFORGE_CONNECTION_STRING",
      });
    case "nile":
      return VendorConfigSchema.parse({
        base_url: "https://global.thenile.dev",
        auth_type: "bearer",
        auth_header: "Authorization",
        auth_env: "NILE_API_KEY",
        sql_dialect: "postgres",
        sql_connection_env: "NILE_DATABASE_URL",
      });
    case "turso":
      return VendorConfigSchema.parse({
        base_url: "https://${TURSO_SANDBOX_DATABASE}-${TURSO_ORG}.turso.io",
        auth_type: "bearer",
        auth_env: "TURSO_DATABASE_AUTH_TOKEN",
      });
    case "mongodb-atlas":
      return VendorConfigSchema.parse({
        base_url: "https://cloud.mongodb.com",
        auth_type: "none",
        auth_env: "ATLAS_CONNECTION_STRING",
        mongo_connection_env: "ATLAS_CONNECTION_STRING",
        mongo_database: "axarena_eval",
      });
    case "convex":
      return VendorConfigSchema.parse({
        base_url: "${CONVEX_URL}",
        auth_type: "bearer",
        auth_header: "Authorization",
        auth_env: "CONVEX_DEPLOY_KEY",
      });
    default:
      return null;
  }
}

function pgCheck(sql_query: string, assert_field: string, expected: string | number | boolean, description: string): OracleCheck {
  return OracleCheckSchema.parse({
    sql_dialect: "postgres",
    sql_query,
    assert_field,
    expected,
    description,
  });
}

function tursoSqlCheck(sql: string, assert_field: string, expected: string | number | boolean, description: string): OracleCheck {
  return OracleCheckSchema.parse({
    read_method: "POST",
    read_path_template: "/v2/pipeline",
    read_body_template: {
      requests: [
        {
          type: "execute",
          stmt: { sql },
        },
      ],
    },
    assert_field,
    expected,
    description,
  });
}

function mongoCheck(
  collection: string,
  operation: "count" | "findOne" | "aggregate" | "listCollections",
  query: Omit<NonNullable<OracleCheck["mongo_query"]>, "database" | "collection" | "operation">,
  assert_field: string,
  expected: string | number | boolean,
  description: string,
): OracleCheck {
  return OracleCheckSchema.parse({
    mongo_query: {
      database: "",
      collection,
      operation,
      ...query,
    },
    assert_field,
    expected,
    description,
  });
}

function convexQueryCheck(pathField: string, assert_field: string, expected: string | number | boolean, description: string): OracleCheck {
  return OracleCheckSchema.parse({
    read_method: "POST",
    read_path_template: "/api/query",
    read_body_template: {
      path: `{${pathField}}`,
      args: {},
    },
    assert_field,
    expected,
    description,
  });
}

function convexActionCheck(pathField: string, assert_field: string, expected: string | number | boolean, description: string): OracleCheck {
  return OracleCheckSchema.parse({
    read_method: "POST",
    read_path_template: "/api/action",
    read_body_template: {
      path: `{${pathField}}`,
      args: {},
    },
    assert_field,
    expected,
    description,
  });
}

function postgresSeededTask(task: SuiteTask): OracleExtractItem | null {
  const item = (checks: OracleCheck[]): OracleExtractItem =>
    OracleExtractItemSchema.parse({
      task_id: task.id,
      na: false,
      checks,
    });
  switch (task.skill) {
    case "access-control":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'axarena_acl_{ns}'",
          "0.count",
          1,
          "protected container axarena_acl_{ns} exists",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_acl_{ns}\"",
          "0.count",
          1,
          "one allowed record exists under the protected container",
        ),
      ]);
    case "backup-and-restore":
      return item([pgCheck(
        "SELECT COUNT(*)::int AS count FROM \"axarena_backup_{ns}\" WHERE label = 'marker_{ns}'",
        "0.count",
        1,
        "active database contains the backup marker row after the backup/export task",
      )]);
    case "change-data-capture":
      return OracleExtractItemSchema.parse({
        task_id: task.id,
        na: false,
        checks: [
          {
            sql_dialect: "postgres",
            sql_query: "SELECT COUNT(*)::int AS count FROM \"{capture_table}\" WHERE row_label = 'cdc_probe_{ns}' OR payload::text LIKE '%cdc_probe_{ns}%'",
            assert_field: "0.count",
            expected: 1,
            description: "agent-reported durable capture table contains the inserted CDC marker",
          },
        ],
      });
    case "data-integrity-and-transactions":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_integrity_{ns}\" WHERE external_id = 'primary_{ns}'",
          "0.count",
          1,
          "exactly one committed record has the protected logical key",
        ),
      ]);
    case "evolve-schema":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'axarena_migrate_{ns}' AND column_name IN ('title', 'status')",
          "0.count",
          2,
          "title remains visible and status exists after schema evolution",
        ),
      ]);
    case "inspect-schema":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'axarena_schema_probe_{ns}' AND column_name IN ('name', 'status')",
          "0.count",
          2,
          "schema inspection target exposes name and status fields",
        ),
      ]);
    case "query-records":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_query_items_{ns}\"",
          "0.count",
          3,
          "query container contains exactly the three requested records",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_query_items_{ns}\" WHERE status = 'active'",
          "0.count",
          2,
          "filtered read returns exactly two active records",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_query_items_{ns}\" WHERE status = 'active' AND label IN ('alpha_{ns}', 'gamma_{ns}')",
          "0.count",
          2,
          "the active set is alpha and gamma",
        ),
      ]);
    case "full-text-search":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_search_{ns}\" WHERE content LIKE '%orchard_{ns}%' OR content LIKE '%mountain_{ns}%' OR content LIKE '%harbor_{ns}%'",
          "0.count",
          3,
          "search corpus contains exactly the three required marker items",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_search_{ns}\" WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', 'orchard_{ns}')",
          "0.count",
          1,
          "full-text query returns exactly one orchard match",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_search_{ns}\" WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', 'orchard_{ns}') AND (content ILIKE '%mountain_{ns}%' OR content ILIKE '%harbor_{ns}%')",
          "0.count",
          0,
          "orchard search excludes mountain and harbor records",
        ),
      ]);
    case "vector-search":
      return item([
        pgCheck(
          "SELECT label FROM \"axarena_vectors_{ns}\" ORDER BY embedding <-> '[1,0,0]' LIMIT 1",
          "0.label",
          "alpha_{ns}",
          "nearest vector search ranks alpha first",
        ),
      ]);
    case "write-records":
      return item([
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_write_items_{ns}\" WHERE record_id = 'record_{ns}' AND label = 'final_{ns}'",
          "0.count",
          1,
          "the original record identity survives with the final label",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_write_items_{ns}\" WHERE label = 'draft_{ns}'",
          "0.count",
          0,
          "draft label no longer remains after update",
        ),
        pgCheck(
          "SELECT COUNT(*)::int AS count FROM \"axarena_write_items_{ns}\" WHERE label = 'delete_me_{ns}'",
          "0.count",
          0,
          "throwaway record was deleted",
        ),
      ]);
    default:
      return null;
  }
}

function tursoSeededTask(task: SuiteTask): OracleExtractItem | null {
  const item = (checks: OracleCheck[]): OracleExtractItem =>
    OracleExtractItemSchema.parse({
      task_id: task.id,
      na: false,
      checks,
    });
  switch (task.skill) {
    case "access-control":
      return item([
        tursoSqlCheck(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='axarena_acl_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "axarena_acl_{ns}",
          "protected table axarena_acl_{ns} exists",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_acl_{ns}\"",
          "results.0.response.result.rows.0.0.value",
          "1",
          "one allowed record exists under the protected table",
        ),
      ]);
    case "backup-and-restore":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_backup_{ns}\" WHERE label = 'marker_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "1",
          "the active/restored Turso database contains the backup marker row",
        ),
      ]);
    case "change-data-capture":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"{capture_table}\" WHERE row_label = 'cdc_probe_{ns}' OR payload LIKE '%cdc_probe_{ns}%'",
          "results.0.response.result.rows.0.0.value",
          "1",
          "agent-reported durable capture table contains the inserted CDC marker",
        ),
      ]);
    case "data-integrity-and-transactions":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_integrity_{ns}\" WHERE external_id = 'primary_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "1",
          "exactly one committed record has the protected logical key",
        ),
      ]);
    case "evolve-schema":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM pragma_table_info('axarena_migrate_{ns}') WHERE name IN ('title','status')",
          "results.0.response.result.rows.0.0.value",
          "2",
          "title remains visible and status exists after schema evolution",
        ),
      ]);
    case "inspect-schema":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM pragma_table_info('axarena_schema_probe_{ns}') WHERE name IN ('name','status')",
          "results.0.response.result.rows.0.0.value",
          "2",
          "schema inspection target exposes name and status fields",
        ),
      ]);
    case "query-records":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_query_items_{ns}\"",
          "results.0.response.result.rows.0.0.value",
          "3",
          "query container contains exactly the three requested records",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_query_items_{ns}\" WHERE status = 'active'",
          "results.0.response.result.rows.0.0.value",
          "2",
          "filtered read returns exactly two active records",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_query_items_{ns}\" WHERE status = 'active' AND label IN ('alpha_{ns}', 'gamma_{ns}')",
          "results.0.response.result.rows.0.0.value",
          "2",
          "the active set is alpha and gamma",
        ),
      ]);
    case "full-text-search":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_search_{ns}\" WHERE content LIKE '%orchard_{ns}%' OR content LIKE '%mountain_{ns}%' OR content LIKE '%harbor_{ns}%'",
          "results.0.response.result.rows.0.0.value",
          "3",
          "search corpus contains exactly the three required marker items",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_search_{ns}\" WHERE content MATCH 'orchard_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "1",
          "full-text query returns exactly one orchard match",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_search_{ns}\" WHERE content MATCH 'orchard_{ns}' AND (content LIKE '%mountain_{ns}%' OR content LIKE '%harbor_{ns}%')",
          "results.0.response.result.rows.0.0.value",
          "0",
          "orchard search excludes mountain and harbor records",
        ),
      ]);
    case "vector-search":
      return item([
        tursoSqlCheck(
          "SELECT label FROM \"axarena_vectors_{ns}\" ORDER BY vector_distance_cos(embedding, '[1,0,0]') LIMIT 1",
          "results.0.response.result.rows.0.0.value",
          "alpha_{ns}",
          "nearest vector search ranks alpha first",
        ),
      ]);
    case "write-records":
      return item([
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_write_items_{ns}\" WHERE record_id = 'record_{ns}' AND label = 'final_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "1",
          "the original record identity survives with the final label",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_write_items_{ns}\" WHERE label = 'draft_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "0",
          "draft label no longer remains after update",
        ),
        tursoSqlCheck(
          "SELECT COUNT(*) FROM \"axarena_write_items_{ns}\" WHERE label = 'delete_me_{ns}'",
          "results.0.response.result.rows.0.0.value",
          "0",
          "throwaway record was deleted",
        ),
      ]);
    default:
      return null;
  }
}

function mongoAtlasSeededTask(task: SuiteTask): OracleExtractItem | null {
  const item = (checks: OracleCheck[]): OracleExtractItem =>
    OracleExtractItemSchema.parse({
      task_id: task.id,
      na: false,
      checks,
    });
  switch (task.skill) {
    case "access-control":
      return item([
        mongoCheck(
          "axarena_acl_{ns}",
          "count",
          {},
          "count",
          1,
          "one authorized interaction left an allowed record in the protected collection",
        ),
      ]);
    case "backup-and-restore":
      return item([
        mongoCheck(
          "axarena_backup_{ns}",
          "count",
          { filter: { label: "marker_{ns}" } },
          "count",
          1,
          "restored/recovered MongoDB target contains the backup marker document",
        ),
      ]);
    case "change-data-capture":
      return item([
        mongoCheck(
          "{capture_collection}",
          "count",
          { filter: { $or: [{ row_label: "cdc_probe_{ns}" }, { "fullDocument.label": "cdc_probe_{ns}" }] } },
          "count",
          1,
          "agent-reported durable capture collection contains the inserted change event",
        ),
      ]);
    case "data-integrity-and-transactions":
      return item([
        mongoCheck(
          "axarena_integrity_{ns}",
          "count",
          { filter: { external_id: "primary_{ns}" } },
          "count",
          1,
          "exactly one committed document has the protected logical key",
        ),
      ]);
    case "evolve-schema":
      return item([
        mongoCheck(
          "axarena_migrate_{ns}",
          "listCollections",
          { filter: { name: "axarena_migrate_{ns}" } },
          "0.options.validator.$jsonSchema.properties.status.bsonType",
          "string",
          "collection metadata exposes the evolved status field",
        ),
      ]);
    case "inspect-schema":
      return item([
        mongoCheck(
          "axarena_schema_probe_{ns}",
          "listCollections",
          { filter: { name: "axarena_schema_probe_{ns}" } },
          "0.options.validator.$jsonSchema.properties.name.bsonType",
          "string",
          "collection metadata exposes the name field",
        ),
        mongoCheck(
          "axarena_schema_probe_{ns}",
          "listCollections",
          { filter: { name: "axarena_schema_probe_{ns}" } },
          "0.options.validator.$jsonSchema.properties.status.bsonType",
          "string",
          "collection metadata exposes the status field",
        ),
      ]);
    case "query-records":
      return item([
        mongoCheck(
          "axarena_query_items_{ns}",
          "count",
          {},
          "count",
          3,
          "query collection contains exactly the three requested documents",
        ),
        mongoCheck(
          "axarena_query_items_{ns}",
          "count",
          { filter: { status: "active" } },
          "count",
          2,
          "filtered read returns exactly two active records",
        ),
        mongoCheck(
          "axarena_query_items_{ns}",
          "count",
          { filter: { status: "active", label: { $in: ["alpha_{ns}", "gamma_{ns}"] } } },
          "count",
          2,
          "the active set is alpha and gamma",
        ),
      ]);
    case "full-text-search":
      return item([
        mongoCheck(
          "axarena_search_{ns}",
          "aggregate",
          {
            pipeline: [
              {
                $search: {
                  index: "{text_index_name}",
                  text: { query: "orchard_{ns}", path: "content" },
                },
              },
              { $limit: 1 },
              { $project: { content: 1, _id: 0 } },
            ],
          },
          "0.content",
          "orchard_{ns}",
          "Atlas full-text search returns orchard as the sole top match",
        ),
      ]);
    case "vector-search":
      return item([
        mongoCheck(
          "axarena_vectors_{ns}",
          "aggregate",
          {
            pipeline: [
              {
                $vectorSearch: {
                  index: "{vector_index_name}",
                  path: "embedding",
                  queryVector: [1, 0, 0],
                  numCandidates: 10,
                  limit: 1,
                },
              },
              { $project: { label: 1, _id: 0 } },
            ],
          },
          "0.label",
          "alpha_{ns}",
          "Atlas vector search ranks alpha first",
        ),
      ]);
    case "write-records":
      return item([
        mongoCheck(
          "axarena_write_items_{ns}",
          "count",
          { filter: { label: "draft_{ns}" } },
          "count",
          0,
          "draft label no longer remains after update",
        ),
        mongoCheck(
          "axarena_write_items_{ns}",
          "count",
          { filter: { label: "final_{ns}" } },
          "count",
          1,
          "updated surviving record is final",
        ),
        mongoCheck(
          "axarena_write_items_{ns}",
          "count",
          { filter: { label: "delete_me_{ns}" } },
          "count",
          0,
          "throwaway record was deleted",
        ),
      ]);
    default:
      return null;
  }
}

function convexSeededTask(task: SuiteTask): OracleExtractItem | null {
  const item = (checks: OracleCheck[]): OracleExtractItem =>
    OracleExtractItemSchema.parse({
      task_id: task.id,
      na: false,
      checks,
    });
  switch (task.skill) {
    case "access-control":
      return item([
        convexQueryCheck(
          "acl_probe_query_path",
          "value.allowedRecordCount",
          1,
          "verifier query confirms one allowed owned record is visible under the configured guard",
        ),
        convexQueryCheck(
          "acl_probe_query_path",
          "value.deniedRecordCount",
          0,
          "verifier query confirms the guard hides disallowed records",
        ),
      ]);
    case "backup-and-restore":
      return item([
        convexQueryCheck(
          "backup_probe_query_path",
          "value.markerCount",
          1,
          "verifier query confirms the active/restored deployment contains the backup marker",
        ),
      ]);
    case "change-data-capture":
      return item([
        convexQueryCheck(
          "cdc_probe_query_path",
          "value.eventCount",
          1,
          "verifier query confirms a durable captured event exists for the CDC marker",
        ),
      ]);
    case "data-integrity-and-transactions":
      return item([
        convexQueryCheck(
          "integrity_probe_query_path",
          "value.primaryCount",
          1,
          "verifier query confirms exactly one committed record has the protected logical key",
        ),
        convexQueryCheck(
          "integrity_probe_query_path",
          "value.conflictingCount",
          0,
          "verifier query confirms no conflicting record was committed",
        ),
      ]);
    case "evolve-schema":
      return item([
        convexQueryCheck(
          "migration_probe_query_path",
          "value.statusFieldCount",
          1,
          "verifier query confirms status is visible after schema evolution",
        ),
      ]);
    case "inspect-schema":
      return item([
        convexQueryCheck(
          "schema_probe_query_path",
          "value.hasNameAndStatus",
          true,
          "verifier query confirms name and status fields are visible",
        ),
      ]);
    case "query-records":
      return item([
        convexQueryCheck(
          "query_items_probe_path",
          "value.totalCount",
          3,
          "query container contains exactly the three requested records",
        ),
        convexQueryCheck(
          "query_items_probe_path",
          "value.activeCount",
          2,
          "filtered read returns exactly two active records",
        ),
        convexQueryCheck(
          "query_items_probe_path",
          "value.expectedLabelsCount",
          2,
          "the active set is alpha and gamma",
        ),
      ]);
    case "full-text-search":
      return item([
        convexActionCheck(
          "text_search_probe_path",
          "value.topContent",
          "orchard_{ns}",
          "full-text search returns orchard as the top match",
        ),
        convexActionCheck(
          "text_search_probe_path",
          "value.unexpectedMatchCount",
          0,
          "orchard search excludes mountain and harbor records",
        ),
      ]);
    case "vector-search":
      return item([
        convexActionCheck(
          "vector_probe_query_path",
          "value.topLabel",
          "alpha_{ns}",
          "vector query ranks alpha first",
        ),
      ]);
    case "write-records":
      return item([
        convexQueryCheck(
          "write_probe_query_path",
          "value.draftCount",
          0,
          "draft label no longer remains after update",
        ),
        convexQueryCheck(
          "write_probe_query_path",
          "value.finalCount",
          1,
          "updated surviving record is final",
        ),
        convexQueryCheck(
          "write_probe_query_path",
          "value.deletedCount",
          0,
          "throwaway record was deleted",
        ),
      ]);
    default:
      return null;
  }
}

function seedTaskCheck(vendor: ResolveResult, task: SuiteTask): OracleExtractItem | null {
  if (vendor.category !== "database") return null;
  if (["supabase", "neon", "cockroachdb", "insforge", "nile"].includes(vendor.slug)) return postgresSeededTask(task);
  if (vendor.slug === "turso") return tursoSeededTask(task);
  if (vendor.slug === "mongodb-atlas") return mongoAtlasSeededTask(task);
  if (vendor.slug === "convex") return convexSeededTask(task);
  return null;
}

function applyFixedSupport(item: OracleExtractItem, fixedSupport?: {
  supportedSurfaces: string[];
  unsupportedSurfaces: string[];
  reference?: string;
}): OracleExtractItem {
  if (!fixedSupport) return item;
  const naSurfaces = [...new Set(fixedSupport.unsupportedSurfaces)].filter((surface): surface is ExtractSurfaceId =>
    SurfaceIdSchema.safeParse(surface).success,
  );
  const supportedSurfaces = fixedSupport.supportedSurfaces;
  if (item.na) {
    return {
      ...item,
      na_surfaces: [],
      na_surfaces_reason: undefined,
      support_reference: fixedSupport.reference,
    };
  }
  return {
    ...item,
    na: supportedSurfaces.length === 0,
    na_reason: supportedSurfaces.length === 0 ? (item.na_reason ?? "unsupported for this vendor in support matrix") : undefined,
    na_surfaces: supportedSurfaces.length === 0 ? [] : naSurfaces,
    na_surfaces_reason: naSurfaces.length ? (item.na_surfaces_reason ?? "unsupported for these surfaces in support matrix") : undefined,
    support_reference: fixedSupport.reference,
  };
}

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
  const supportEntries = opts.supportMatrix?.entries.filter((entry) => entry.vendor === vendor.vendor && entry.task_id === task.id) ?? [];
  const fixedSupport = supportEntries.length
    ? {
        supportedSurfaces: supportEntries.filter((entry) => entry.status === "supported").map((entry) => entry.surface),
        unsupportedSurfaces: supportEntries.filter((entry) => entry.status !== "supported").map((entry) => entry.surface),
        reference: supportEntries[0]?.source_concept ? `${vendor.slug}:${task.id}:${supportEntries[0].source_concept}` : undefined,
      }
    : undefined;
  const seeded = seedTaskCheck(vendor, task);
  if (seeded) return applyFixedSupport(seeded, fixedSupport);
  return withRetry(label, async () => {
    const raw = await invokeGenerator(buildTaskPrompt(vendor, task, fixedSupport), {
      requireWebFetch: true,
      fallbackHarness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      heartbeat: { everyMs: 30_000, label },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    });
    const json = await extractJsonObjectWithRepair(raw, {
      fallbackHarness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      label,
    });
    const parsed = OracleExtractItemSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      throw new Error(`oracle-extract for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
    }
    if (parsed.data.task_id !== task.id) {
      throw new Error(`oracle-extract for "${vendor.vendor}" returned task_id "${parsed.data.task_id}", expected "${task.id}"`);
    }
    return applyFixedSupport(parsed.data, fixedSupport);
  });
}

async function extractVendorConfig(
  vendor: ResolveResult,
  opts: ExtractOraclesOptions,
): Promise<VendorConfig> {
  const seeded = seedVendorConfig(vendor);
  if (seeded) return seeded;
  const label = `${vendor.vendor}/vendor_config`;
  return withRetry(label, async () => {
    const raw = await invokeGenerator(buildVendorConfigPrompt(vendor), {
      requireWebFetch: true,
      fallbackHarness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      heartbeat: { everyMs: 30_000, label },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    });
    const json = await extractJsonObjectWithRepair(raw, {
      fallbackHarness: opts.harness ?? "claude-code",
      model: opts.model,
      effort: opts.effort,
      label,
    });
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
  const [vendorConfig, taskSettled] = await Promise.all([
    extractVendorConfig(vendor, opts),
    mapSettledLimit(
      suite.tasks,
      PER_VENDOR_TASK_CONCURRENCY,
      (task) => extractTaskCheck(vendor, task, opts),
    ),
  ]);
  const taskFailures = taskSettled
    .map((result, index) => ({ result, task: suite.tasks[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; task: SuiteTask | undefined } => entry.result.status === "rejected");
  if (taskFailures.length > 0) {
    const details = taskFailures
      .map((entry) => `${entry.task?.id ?? "unknown"}: ${entry.result.reason instanceof Error ? entry.result.reason.message : String(entry.result.reason)}`)
      .join("; ");
    throw new Error(`oracle extraction failed for ${vendor.vendor} on ${taskFailures.length} task(s): ${details}`);
  }
  const tasks = taskSettled
    .filter((result): result is PromiseFulfilledResult<OracleExtractItem> => result.status === "fulfilled")
    .map((result) => result.value);
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
  const settled = await mapSettledLimit(
    vendors,
    VENDOR_EXTRACTION_CONCURRENCY,
    (vendor) => extractOracles(vendor, suite, opts),
  );
  return settled.map((s, i) => {
    const vendor = vendors[i]!.vendor;
    return s.status === "fulfilled"
      ? { vendor, ok: true as const, result: s.value }
      : { vendor, ok: false as const, error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
  });
}

/** Path where an oracle-extract result is persisted (DAEB v1: oracles.yaml). */
export function oracleExtractPath(root: string, slug: string, _suiteName: string): string {
  return daebOraclesPath(root, slug);
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
