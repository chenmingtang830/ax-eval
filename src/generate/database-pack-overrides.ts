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
  "For DAEB-1 Convex database tasks, prefer that preview-deployment path by default whenever the task needs task-local",
  "tables, queries, actions, or verifier functions. Do not assume the base deployment already exposes benchmark helper",
  "functions for this namespace. After deploying, invoke the exact exported public function paths you just created and",
  "smoke-check them on the preview deployment before finalizing the reported `*_probe_path` fields.",
].join(" ");

const CONVEX_VERIFIER_CONTRACTS: Record<string, string> = {
  "db-T01-access-control":
    "Convex verifier contract: report `acl_probe_query_path` as a public query path that accepts `{}` and returns `{allowedRecordCount:number, deniedRecordCount:number}`.",
  "db-T03-change-data-capture":
    "Convex verifier contract: report `cdc_probe_query_path` as a public query path that accepts `{}` and returns `{eventCount:number}`.",
  "db-T04-define-data-container":
    "Convex verifier contract: report `items_schema_query_path` as a public query path that accepts `{}` and returns `{hasLabelField:boolean}`.",
  "db-T05-evolve-schema":
    "Convex verifier contract: report `migration_probe_query_path` as a public query path that accepts `{}` and returns `{statusFieldCount:number}`.",
  "db-T06-inspect-schema":
    "Convex verifier contract: report `schema_probe_query_path` as a public query path that accepts `{}` and returns `{hasNameAndStatus:boolean}`.",
  "db-T07-query-records":
    "Convex verifier contract: report `query_items_probe_path` as a public query path that accepts `{}` and returns `{activeCount:number, expectedLabelsCount:number}`.",
  "db-T08-server-side-execution":
    "Convex verifier contract: report `server_execution_probe_path` as a public action path that accepts `{}` and returns the string `axarena_ok_{ns}`.",
  "db-T09-vector-search":
    "Convex verifier contract: report `vector_probe_query_path` as a public action path that accepts `{}` and returns `{topLabel:string}`.",
  "db-T10-write-records":
    "Convex verifier contract: report `write_probe_query_path` as a public query path that accepts `{}` and returns `{finalCount:number, deletedCount:number}`.",
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
  "supabase",
  "turso",
]);

const SQL_SERVER_ROUTINE_CONTRACT_NOTE = [
  "SQL server-side routine contract: for this task, create a zero-argument routine whose body returns",
  "the literal marker value directly. Do not rely on bind parameters inside `CREATE FUNCTION` or",
  "`CREATE PROCEDURE`; bind parameters are for the outer query execution, not for static routine bodies.",
  "If the vendor surface requires modeling the invocation through a trigger or helper table, persist the",
  "marker in a result table column named `value` and report that table as `result_table` for verification.",
].join(" ");

const SQL_WRITE_LIFECYCLE_CONTRACT_NOTE = [
  "SQL write lifecycle contract: before reporting this task, read back the target table and ensure the",
  "postcondition is exact: one row labeled `final_{ns}`, zero rows labeled `draft_{ns}`, and zero rows",
  "labeled `delete_me_{ns}`. If a partial attempt or retry created extra marker rows, fix only this",
  "run-scoped table before reporting the gid.",
].join(" ");

const NEON_CLI_ROLE_CONTRACT_NOTE = [
  "Neon CLI contract: when operating through `neonctl psql` or `neonctl connection-string`, do not rely",
  "on Neon CLI's default role/database inference. In shared benchmark branches, multiple roles may exist.",
  "Silently parse `process.env.NEON_DATABASE_URL` to get the URL username as the role name and the path",
  "database as the database name, then pass `--project-id ${NEON_PROJECT_ID}`, `--role-name <role>`, and",
  "`--database-name <database>` on `neonctl psql` calls. If `NEON_BRANCH_ID` is set, use it as the branch",
  "argument. Never print the connection string or token values.",
].join(" ");

const MONGODB_ATLAS_TASK_CONTRACTS: Record<string, string> = {
  "db-T03-change-data-capture": [
    "MongoDB Atlas change-stream contract: open the change stream before inserting the probe document,",
    "then persist the observed insert event into a durable capture collection and report that",
    "`capture_collection` value for verification. A stream opened after the insert may miss the event.",
  ].join(" "),
  "db-T09-vector-search": [
    "MongoDB Atlas vector-search contract: when creating Atlas Search/vector indexes through the Node",
    "driver, do not enable Stable API strict mode (`apiStrict: true`), because `createSearchIndexes`",
    "is not part of API Version 1. Use the official driver path without strict API mode, create the",
    "vector index, wait until it is queryable if necessary, and report `vector_index_name`.",
  ].join(" "),
};

export function applyDatabasePackPromptOverride(
  vendor: ResolveResult,
  task: SuiteTask,
  prompt: string,
): string {
  if (vendor.category !== "database") return prompt;
  if (SQL_IDENTIFIER_CONTRACT_VENDORS.has(vendor.slug) && task.id.startsWith("db-")) {
    prompt = `${prompt}\n\n${SQL_IDENTIFIER_CONTRACT_NOTE}`;
    if (task.id === "db-T08-server-side-execution") prompt = `${prompt}\n\n${SQL_SERVER_ROUTINE_CONTRACT_NOTE}`;
    if (task.id === "db-T10-write-records") prompt = `${prompt}\n\n${SQL_WRITE_LIFECYCLE_CONTRACT_NOTE}`;
  }
  if (vendor.slug === "neon" && task.id.startsWith("db-")) prompt = `${prompt}\n\n${NEON_CLI_ROLE_CONTRACT_NOTE}`;
  if (vendor.slug === "insforge" && task.id.startsWith("db-")) prompt = `${prompt}\n\n${INSFORGE_API_SCHEMA_NOTE}`;
  if (vendor.slug === "mongodb-atlas" && task.id.startsWith("db-")) {
    const contract = MONGODB_ATLAS_TASK_CONTRACTS[task.id];
    if (contract) prompt = `${prompt}\n\n${contract}`;
  }
  if (vendor.slug !== "convex") return prompt;
  if (!task.id.startsWith("db-")) return prompt;
  return [
    prompt,
    "",
    CONVEX_IDENTIFIER_NOTE,
    CONVEX_DEPLOYMENT_FLOW_NOTE,
    CONVEX_VERIFIER_CONTRACTS[task.id],
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
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      cli: {
        bin: "psql",
        install: "Install PostgreSQL client tools (for example: brew install libpq, then add libpq/bin to PATH).",
        help: "psql --help",
        docs_url: "https://www.cockroachlabs.com/docs/stable/connect-to-the-database.html",
        auth: { kind: "token", token_env: extract.vendor_config.sql_connection_env },
      },
      sdk: {
        package: "pg",
        language: "node",
        install: "npm install pg",
        reference_url: "https://www.cockroachlabs.com/docs/stable/build-a-nodejs-app-with-cockroachdb.html",
        auth: { kind: "token", token_env: extract.vendor_config.sql_connection_env },
      },
      mcp: null,
    };
  }
  if (vendor.slug === "mongodb-atlas") {
    if (!extract.vendor_config.mongo_connection_env) return undefined;
    return {
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      cli: {
        bin: "mongosh",
        install: "Install MongoDB Shell from the official MongoDB Shell installation docs.",
        help: "mongosh --help",
        docs_url: "https://www.mongodb.com/docs/mongodb-shell/",
        auth: { kind: "token", token_env: extract.vendor_config.mongo_connection_env },
      },
      sdk: {
        package: "mongodb",
        language: "node",
        install: "npm install mongodb",
        reference_url: "https://www.mongodb.com/docs/drivers/node/current/",
        auth: { kind: "token", token_env: extract.vendor_config.mongo_connection_env },
      },
      mcp: null,
    };
  }
  if (vendor.slug === "turso") {
    return {
      vendor: vendor.vendor,
      slug: vendor.slug,
      extracted_at: "2026-07-02T00:00:00.000Z",
      cli: {
        bin: "turso",
        install: "Install the official Turso CLI from the Turso CLI documentation.",
        help: "turso --help",
        docs_url: "https://docs.turso.tech/cli",
        auth: { kind: "token", token_env: extract.vendor_config.auth_env },
      },
      sdk: {
        package: "@libsql/client",
        language: "node",
        install: "npm install @libsql/client",
        reference_url: "https://docs.turso.tech/sdk/ts/reference",
        auth: { kind: "token", token_env: extract.vendor_config.auth_env },
      },
      mcp: null,
    };
  }
  return undefined;
}
