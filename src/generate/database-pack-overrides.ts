import type { SuiteTask } from "./suite.js";
import type { SurfaceExtractResult } from "./surface-extract.js";
import type { OracleExtractResult } from "./task-extract.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CONVEX_IDENTIFIER_NOTE = [
  "",
  "Convex-specific database adapter note: Convex table and function identifiers may only use letters, digits,",
  "and underscores, while the canonical DAEB namespace may contain hyphens. When a canonical container or",
  "function name is not a valid Convex identifier, use a deterministic Convex-safe identifier by replacing",
  "non-alphanumeric characters with underscores. Preserve the exact canonical names and marker strings in",
  "record values or verifier query results, and report the requested verifier query path for read-back.",
  "This exception only changes Convex code identifiers; it does not change the canonical outcome marker.",
].join(" ");

const CONVEX_DEPLOYMENT_FLOW_NOTE = [
  "Convex deployment/admin contract: `CONVEX_DEPLOY_KEY` is the deployment-admin credential, not an end-user",
  "Bearer token. If the provided `CONVEX_URL` rejects the deploy key for the public HTTP endpoints, treat that",
  "as a deployment-selection issue, not a task failure: create or reuse the preview deployment associated with",
  "this run (for example via `convex deploy --preview-name <run-scoped-name>`), then use that preview deployment",
  "URL as the API base for the task. After deployment, call `/api/mutation`, `/api/query`, and `/api/action`",
  "against that deployment URL with `Authorization: Convex <CONVEX_DEPLOY_KEY>`. Report concrete public function",
  "paths such as `arena:probeQuery` in the task result fields; never leave `{probe_path}` placeholders or null",
  "when the task actually succeeded. If an authenticated call on the original `CONVEX_URL` returns `403 Unauthorized`,",
  "stop guessing pre-existing mutation/action names on that deployment. For tasks that require creating data containers,",
  "probe queries, or server-side routines, immediately switch to the preview-deployment flow and deploy task-local",
  "public functions for that task instead of retrying guessed function paths on the unauthorized base deployment.",
  "Within the same vendor/surface lane, prefer reusing the existing local Convex project scaffold, preview-deployment",
  "workflow, and any already-available `convex` binary or `node_modules/convex` install that proved successful on an",
  "earlier task. Do not restart from a fresh package-install remediation path unless you have concrete evidence that the",
  "previous scaffold is missing or broken. In particular, if one task has already deployed successfully, treat later",
  "tasks as edits to that working local scaffold first, not as a reason to run `npm install` or other package bootstrap",
  "steps again.",
  "For DAEB Convex database tasks, prefer that preview-deployment path by default whenever the task needs task-local",
  "tables, queries, actions, or verifier functions. Do not assume the base deployment already exposes benchmark helper",
  "functions for this namespace. After deploying, invoke the exact exported public function paths you just created and",
  "smoke-check them on the preview deployment before finalizing the reported `*_probe_path` fields.",
].join(" ");

const CONVEX_VERIFIER_CONTRACTS: Record<string, string> = {
  "access-control":
    "Convex verifier contract: report `acl_probe_query_path` as a public query path that accepts `{}` and returns `{allowedRecordCount:number, deniedRecordCount:number}`.",
  "data-integrity-and-transactions":
    "Convex verifier contract: report `integrity_probe_query_path` as a public query path that accepts `{}` and returns `{primaryCount:number, conflictingCount:number}`.",
  "evolve-schema":
    "Convex verifier contract: report `migration_probe_query_path` as a public query path that accepts `{}` and returns `{statusFieldCount:number}`.",
  "query-records":
    "Convex verifier contract: report `query_items_probe_path` as a public query path that accepts `{}` and returns `{totalCount:number, activeCount:number, expectedLabelsCount:number}`.",
  "vector-search":
    "Convex verifier contract: report `vector_probe_query_path` as a public action path that accepts `{}` and returns `{topLabel:string}`.",
  "write-records":
    "Convex verifier contract: report `write_probe_query_path` as a public query path that accepts `{}` and returns `{draftCount:number, finalCount:number, deletedCount:number}`.",
  "change-data-capture":
    "Convex verifier contract: report `cdc_probe_query_path` as a public query path that accepts `{}` and returns `{eventCount:number}`.",
  "full-text-search":
    "Convex verifier contract: report `text_search_probe_path` as a public action path that accepts `{}` and returns `{topContent:string, unexpectedMatchCount:number}`.",
  "inspect-schema":
    "Convex verifier contract: report `schema_probe_query_path` as a public query path that accepts `{}` and returns `{hasNameAndStatus:boolean}`.",
};

const INSFORGE_API_SCHEMA_NOTE = [
  "Insforge-specific database adapter note: when operating through the API surface, use the",
  "documented admin table/schema endpoints as the first path for schema setup: `POST /api/database/tables`",
  "with `tableName`, `columns`, and `rlsEnabled`. On current hosted Insforge projects, default to the",
  "hosted request shape immediately: `columns: [{columnName, type, isNullable, isUnique}]`. Do not try",
  "the legacy `{name, nullable, unique}` shape first unless the live API explicitly rejects",
  "`columnName`-style fields as unknown. For textual columns on the admin create-table endpoint, use",
  "the hosted type name `string` and do not use SQL names like `text`; hosted projects may otherwise",
  "fail with `Cannot read properties of undefined (reading 'sqlType')`. Use the same live schema field",
  "names for `PATCH /api/database/tables/{tableName}/schema` and its `addColumns` body. Admin bearer",
  "tokens are project credentials, not end-user session cookies: do not call user-session discovery",
  "endpoints such as `GET /api/auth/sessions/current` to discover the active principal for DAEB tasks.",
  "After creating a table, re-read `GET /api/database/tables/{tableName}/schema` (and, if needed,",
  "`GET /api/database/tables`) before attempting row writes so the hosted control plane has acknowledged",
  "the table. Prefer single-record JSON objects rather than array batch bodies unless the live docs",
  "explicitly require arrays. Use the PostgREST-style record endpoint",
  "`/api/database/records/{tableName}` only after schema read-back succeeds. If that record endpoint",
  "still returns `404` for a table whose schema read-back succeeds, treat it as a hosted admin/data-path",
  "mismatch: stop retrying the records endpoint for that task and switch the row-level portion to one",
  "small task-local SQL fallback. Do not batch the benchmark's many CREATE TABLE, RLS policy, trigger,",
  "and function statements into one `/api/database/migrations` request; Insforge's migration parser may",
  "reject complex SQL for security reasons. Custom migrations or raw SQL are fallback paths only for",
  "small task-local SQL fragments that the admin table/schema endpoints cannot express. When using",
  "`/api/database/migrations`, keep the migration `name` lowercase letters, numbers, and hyphens only,",
  "and make it globally monotonic for the project so hosted Insforge does not reject it as older than an",
  "already-applied migration. Invoke database RPC functions through `POST /api/database/rpc/{functionName}`,",
  "not under `/api/database/records/`. If a migration returns a security-parser rejection or version",
  "conflict, stop using that migration path for the task instead of repeatedly retrying it.",
].join(" ");

const SQL_IDENTIFIER_CONTRACT_NOTE = [
  "Database SQL identifier contract: DAEB namespaces may contain hyphens. When issuing SQL through",
  "a SQL-compatible API, CLI, or SDK path, double-quote table, function, policy, index, trigger,",
  "schema, and other SQL identifiers that include canonical task names or `{ns}`. Preserve the exact",
  "canonical names expected by the verifier; do not replace hyphens with underscores for SQL-backed",
  "vendors. Use parameterized values for marker strings and row data; only SQL identifiers need",
  "identifier quoting.",
].join(" ");

const SQL_IDENTIFIER_CONTRACT_VENDORS = new Set([
  "cockroachdb",
  "insforge",
  "neon",
  "nile",
  "supabase",
  "turso",
]);

const SQL_DATA_PLANE_ENV: Record<string, string> = {
  neon: "NEON_DATABASE_URL",
  cockroachdb: "COCKROACH_CONNECTION_STRING",
  supabase: "SUPABASE_DB_URL",
  insforge: "INSFORGE_CONNECTION_STRING",
  nile: "NILE_DATABASE_URL",
};

const SQL_WRITE_LIFECYCLE_CONTRACT_NOTE = [
  "SQL write lifecycle contract: before reporting this task, read back the target table and ensure the",
  "postcondition is exact: one row labeled `final_{ns}`, zero rows labeled `draft_{ns}`, and zero rows",
  "labeled `delete_me_{ns}`. If a partial attempt or retry created extra marker rows, fix only this",
  "run-scoped table before reporting the gid.",
].join(" ");

const INSFORGE_RECORDS_SQL_FALLBACK_NOTE = [
  "Insforge query-records completion contract: if the documented records endpoint returns 404 after a successful schema read-back,",
  "do not stop or report N/A. Use process.env.INSFORGE_CONNECTION_STRING to create the exact three rows and run the filtered SQL read",
  "for this task-local table, then report the table as gid. This fallback is required because the verifier reads the same Postgres state.",
].join(" ");

const STRICT_DENIED_SQL_ROLE_NOTE = [
  "Strict access-control verifier contract: create the denied principal with the exact deterministic SQL role name `axarena_acl_denied_{ns}`,",
  "where every hyphen in `{ns}` is replaced with an underscore (and do not otherwise alter the name).",
  "Create it with no LOGIN and no privilege to read the protected table. Ensure the default SQL identity can SET ROLE to it.",
  "Configure the policy/grants so that role is denied while the default SQL identity can insert the required authorized row.",
  "Do not parameterize SQL role names or other DDL identifiers (for example, do not use $1 in CREATE ROLE, GRANT, or CREATE POLICY); quote identifiers directly after validating their source.",
  "The verifier derives that role name from the namespace, SET ROLEs on its own admin connection, and requires SQLSTATE 42501.",
  "If you SET ROLE for negative testing, run RESET ROLE (or open a fresh connection) before any later task in the same session.",
].join(" ");

function strictDeniedSqlIdentityNote(): string {
  return [
    STRICT_DENIED_SQL_ROLE_NOTE,
  ].join(" ");
}

const NEON_SQL_CLI_CONTRACT_NOTE = [
  "Neon SQL CLI contract: run data-plane SQL through plain `psql` with `NEON_DATABASE_URL`; do not use",
  "`neonctl psql` or `neonctl connection-string` for benchmark DDL/DML/query work. `NEON_API_KEY`,",
  "`NEON_PROJECT_ID`, and `NEON_BRANCH_ID` are reserved for explicit Neon control-plane operations.",
  "Never print the connection string or token values.",
].join(" ");

const NILE_CLI_CONTRACT_NOTE = [
  "Nile SQL CLI contract: run data-plane SQL through `psql` with `NILE_DATABASE_URL`, not through",
  "the Nile control-plane CLI. Before executing SQL, confirm the database name in `NILE_DATABASE_URL`",
  "matches `NILE_DB`; use that connection only for the declared disposable sandbox database.",
  "Use `NILE_API_KEY` and `NILE_WORKSPACE` only for explicit Nile control-plane operations.",
  "Never print the API key or connection string.",
].join(" ");

const MONGODB_ATLAS_TASK_CONTRACTS: Record<string, string> = {
  "vector-search": [
    "MongoDB Atlas vector-search contract: when creating Atlas Search/vector indexes through the Node",
    "driver, do not enable Stable API strict mode (`apiStrict: true`), because `createSearchIndexes`",
    "is not part of API Version 1. Use the official driver path without strict API mode, create the",
    "vector index, wait until it is queryable if necessary, and report `vector_index_name`.",
  ].join(" "),
  "change-data-capture": [
    "MongoDB Atlas change-stream contract: open the change stream before inserting the probe document,",
    "then persist the observed insert event into a durable capture collection and report that",
    "`capture_collection` value for verification. A stream opened after the insert may miss the event.",
  ].join(" "),
  "full-text-search": [
    "MongoDB Atlas full-text-search contract: create an Atlas Search text index for `content`, wait",
    "until it is queryable, and report its concrete name as `text_index_name` for verification.",
  ].join(" "),
};

const TURSO_DENIED_TOKEN_NOTE = [
  "Strict Turso access-control verifier contract: mint a separate Turso database auth token that cannot",
  "read the protected table `axarena_acl_{ns}` (for example a token scoped only to another database, or",
  "otherwise lacking read privilege on this table). Report that concrete token string in the task result",
  "field `denied_database_auth_token`. The verifier POSTs `/v2/pipeline` against the protected table",
  "using that token and expects HTTP 401/403 with a permission-denied outcome. Do not reuse the primary",
  "sandbox database token for the denied probe, and do not leave the field empty or null.",
].join(" ");

const SUPABASE_API_DATA_PLANE_NOTE = [
  "Supabase API data-plane contract: for this API-surface cell, operate through the documented PostgREST/HTTP",
  "API against the pack base URL with `SUPABASE_API_KEY` (Authorization / apikey as documented). Do not use",
  "`psql` or `SUPABASE_DB_URL` for agent actions on this cell — SQL wire is reserved for CLI cells and for",
  "the verifier's independent read-back.",
].join(" ");

const COCKROACH_SQL_CLI_CONTRACT_NOTE = [
  "CockroachDB SQL CLI contract: run data-plane SQL through `cockroach sql` with",
  "`COCKROACH_CONNECTION_STRING` (or the documented connection URL). Do not use generic `psql` examples",
  "as the primary path when `cockroach sql` is available. Never print the connection string.",
].join(" ");

function sqlCliDataPlaneNote(vendorSlug: string, sqlEnv: string): string {
  if (vendorSlug === "cockroachdb") {
    return [
      `Use the documented SQL command-line data plane (\`cockroach sql\`) with process.env.${sqlEnv}`,
      "for DDL/DML/query operations. Do not assume the vendor control-plane CLI executes arbitrary SQL.",
    ].join(" ");
  }
  return [
    `Use the documented SQL command-line data plane (for example, psql) with process.env.${sqlEnv}`,
    "for DDL/DML/query operations. Do not assume the vendor control-plane CLI executes arbitrary SQL.",
  ].join(" ");
}

export function applyDatabasePackPromptOverride(
  vendor: ResolveResult,
  task: SuiteTask,
  prompt: string,
  /** Support-matrix-narrowed surfaces for this vendor/task; defaults to suite task surfaces. */
  allowedSurfaces?: string[],
): string {
  if (vendor.category !== "database") return prompt;
  const surfaces = allowedSurfaces ?? task.allowed_surfaces;
  const cliAllowed = surfaces.includes("cli");
  const apiAllowed = surfaces.includes("api");

  if (SQL_IDENTIFIER_CONTRACT_VENDORS.has(vendor.slug) && task.id.startsWith("db-")) {
    prompt = `${prompt}\n\n${SQL_IDENTIFIER_CONTRACT_NOTE}`;
    const sqlEnv = SQL_DATA_PLANE_ENV[vendor.slug];
    if (sqlEnv && cliAllowed) {
      prompt = `${prompt}\n\n${sqlCliDataPlaneNote(vendor.slug, sqlEnv)}`;
    }
    if (vendor.slug === "supabase" && apiAllowed && !cliAllowed) {
      prompt = `${prompt}\n\n${SUPABASE_API_DATA_PLANE_NOTE}`;
    }
    if (vendor.slug === "supabase" && apiAllowed && cliAllowed) {
      prompt = `${prompt}\n\n${SUPABASE_API_DATA_PLANE_NOTE} When the assigned surface is CLI, use psql with process.env.SUPABASE_DB_URL instead.`;
    }
    if (task.skill === "write-records") prompt = `${prompt}\n\n${SQL_WRITE_LIFECYCLE_CONTRACT_NOTE}`;
  }
  if (vendor.slug === "neon" && task.id.startsWith("db-") && cliAllowed) {
    prompt = `${prompt}\n\n${NEON_SQL_CLI_CONTRACT_NOTE}`;
  }
  if (vendor.slug === "cockroachdb" && task.id.startsWith("db-") && cliAllowed) {
    prompt = `${prompt}\n\n${COCKROACH_SQL_CLI_CONTRACT_NOTE}`;
  }
  if (vendor.slug === "nile" && task.id.startsWith("db-") && cliAllowed) {
    prompt = `${prompt}\n\n${NILE_CLI_CONTRACT_NOTE}`;
  }
  if (vendor.slug === "insforge" && task.id.startsWith("db-") && apiAllowed) {
    prompt = `${prompt}\n\n${INSFORGE_API_SCHEMA_NOTE}`;
  }
  if (vendor.slug === "insforge" && task.skill === "query-records") {
    prompt = `${prompt}\n\n${INSFORGE_RECORDS_SQL_FALLBACK_NOTE}`;
  }
  if (SQL_DATA_PLANE_ENV[vendor.slug] && task.skill === "access-control") {
    prompt = `${prompt}\n\n${strictDeniedSqlIdentityNote()}`;
  }
  if (vendor.slug === "turso" && task.skill === "access-control") {
    prompt = `${prompt}\n\n${TURSO_DENIED_TOKEN_NOTE}`;
  }
  if (vendor.slug === "mongodb-atlas" && task.id.startsWith("db-")) {
    const contract = MONGODB_ATLAS_TASK_CONTRACTS[task.skill];
    if (contract) prompt = `${prompt}\n\n${contract}`;
  }
  if (vendor.slug !== "convex") return prompt;
  if (!task.id.startsWith("db-")) return prompt;
  return [
    prompt,
    "",
    CONVEX_IDENTIFIER_NOTE,
    CONVEX_DEPLOYMENT_FLOW_NOTE,
    CONVEX_VERIFIER_CONTRACTS[task.skill],
  ].filter(Boolean).join("\n\n");
}

/** Database-specific surface fallback used only when the surface-extract stage
 * did not produce explicit CLI/SDK metadata. Keep this category-specific: core
 * composition still enforces that non-API task surfaces have declarations. */
export function databaseSurfaceFallback(
  vendor: ResolveResult,
  extract: OracleExtractResult,
): SurfaceExtractResult | undefined {
  if (vendor.slug === "cockroachdb") {
    if (extract.vendor_config.sql_dialect !== "postgres" || !extract.vendor_config.sql_connection_env) return undefined;
    return {
      schema: "ax.surface-extract/v1",
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      extraction_context: {
        mode: "manual-review",
        notes: "Vendor-specific fallback for SQL wire protocol surfaces.",
      },
      audit_status: "candidate",
      audit_notes: ["Fallback surface generated from SQL connection metadata; verify docs before publication."],
      cli: {
        bin: "cockroach",
        install: "Install CockroachDB (includes the `cockroach sql` client).",
        help: "cockroach sql --help",
        docs_url: "https://www.cockroachlabs.com/docs/stable/cockroach-sql.html",
        auth: { kind: "token", token_env: extract.vendor_config.sql_connection_env, token_env_aliases: [] },
      },
      sdk: {
        package: "pg",
        language: "node",
        install: "npm install pg",
        reference_url: "https://www.cockroachlabs.com/docs/stable/build-a-nodejs-app-with-cockroachdb.html",
        auth: { kind: "token", token_env: extract.vendor_config.sql_connection_env, token_env_aliases: [] },
      },
      mcp: null,
    };
  }
  if (vendor.slug === "mongodb-atlas") {
    if (!extract.vendor_config.mongo_connection_env) return undefined;
    return {
      schema: "ax.surface-extract/v1",
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      extraction_context: {
        mode: "manual-review",
        notes: "Vendor-specific fallback for MongoDB wire protocol surfaces.",
      },
      audit_status: "candidate",
      audit_notes: ["Fallback surface generated from MongoDB connection metadata; verify docs before publication."],
      cli: {
        bin: "mongosh",
        install: "Install MongoDB Shell from the official MongoDB Shell installation docs.",
        help: "mongosh --help",
        docs_url: "https://www.mongodb.com/docs/mongodb-shell/",
        auth: { kind: "token", token_env: extract.vendor_config.mongo_connection_env, token_env_aliases: [] },
      },
      sdk: {
        package: "mongodb",
        language: "node",
        install: "npm install mongodb",
        reference_url: "https://www.mongodb.com/docs/drivers/node/current/",
        auth: { kind: "token", token_env: extract.vendor_config.mongo_connection_env, token_env_aliases: [] },
      },
      mcp: null,
    };
  }
  if (vendor.slug === "turso") {
    return {
      schema: "ax.surface-extract/v1",
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      extraction_context: {
        mode: "manual-review",
        notes: "Vendor-specific fallback for Turso CLI and libSQL SDK surfaces.",
      },
      audit_status: "candidate",
      audit_notes: ["Fallback surface generated from vendor pack auth metadata; verify docs before publication."],
      cli: {
        bin: "turso",
        install: "Install the official Turso CLI from the Turso CLI documentation.",
        help: "turso --help",
        docs_url: "https://docs.turso.tech/cli",
        auth: { kind: "token", token_env: extract.vendor_config.auth_env, token_env_aliases: [] },
      },
      sdk: {
        package: "@libsql/client",
        language: "node",
        install: "npm install @libsql/client",
        reference_url: "https://docs.turso.tech/sdk/ts/reference",
        auth: { kind: "token", token_env: extract.vendor_config.auth_env, token_env_aliases: [] },
      },
      mcp: null,
    };
  }
  return undefined;
}

/** Official hostnames for behavioral discovery scoring (site + docs). */
export function officialDomainsFromVendor(vendor: ResolveResult): string[] {
  const domains = new Set<string>();
  for (const raw of [vendor.site_url, vendor.docs_url]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
      if (!host) continue;
      domains.add(host);
      const parts = host.split(".");
      if (parts.length > 2) domains.add(parts.slice(-2).join("."));
    } catch {
      /* ignore malformed URLs */
    }
  }
  return [...domains];
}

function authSchemeLabel(authType: OracleExtractResult["vendor_config"]["auth_type"]): string {
  switch (authType) {
    case "bearer":
      return "Bearer API token / personal access token";
    case "api-key":
      return "API key header";
    case "oauth":
      return "OAuth bearer token";
    case "none":
      return "no auth header (public or connection-string only)";
    default:
      return "documented API credential";
  }
}

/**
 * Representative control/data-plane call the agent should discover on the API
 * surface. Used only for the behavioral discovery *score* — prompts must not
 * leak this string (executor already keeps Phase 0 free of endpoints).
 */
const DAEB_CANONICAL_ENDPOINT: Record<string, string> = {
  neon: "GET /projects",
  cockroachdb: "GET /clusters",
  turso: "POST /v2/pipeline",
  supabase: "GET /rest/v1",
  insforge: "GET /api/database/tables",
  nile: "GET /databases",
  "mongodb-atlas": "GET /api/atlas/v2/groups",
  convex: "POST /api/query",
};

const DAEB_PRODUCT_LABEL: Record<string, string> = {
  neon: "Neon",
  cockroachdb: "CockroachDB",
  turso: "Turso",
  supabase: "Supabase",
  insforge: "Insforge",
  nile: "Nile",
  "mongodb-atlas": "MongoDB Atlas",
  convex: "Convex",
};

/** Cold-start DiscoverySpec for DAEB composed packs (Agent Discovery Score). */
export function databaseDiscoverySpec(
  vendor: ResolveResult,
  extract: OracleExtractResult,
): import("../schemas.js").DiscoverySpec {
  const domains = officialDomainsFromVendor(vendor);
  const product = DAEB_PRODUCT_LABEL[vendor.slug] ?? vendor.vendor;
  const canonical =
    DAEB_CANONICAL_ENDPOINT[vendor.slug] ??
    (extract.vendor_config.base_url ? "GET /" : "");
  return {
    product,
    goal: [
      `You are about to operate ${product} programmatically on its documented API / CLI data plane.`,
      `First work out, from scratch, how ${product}'s public agent-facing surfaces work:`,
      `base URL (or CLI entrypoint), authentication, and at least one documented read or write call`,
      `you can use to confirm the surface is live.`,
      `You are NOT given any endpoint, base URL, or documentation link; find them yourself.`,
    ].join(" "),
    official_domains: domains,
    canonical_endpoint: canonical,
    deprecated_markers: [],
    auth_scheme: authSchemeLabel(extract.vendor_config.auth_type),
  };
}
