import type { SuiteTask } from "./suite.js";
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
  "Insforge-specific database adapter note: when operating through the API surface, prefer the",
  "documented admin table/schema endpoints for table creation and schema evolution. Avoid batching",
  "many CREATE TABLE, RLS policy, trigger, and function statements into one custom migration; Insforge's",
  "migration parser may reject complex SQL for security reasons. Use small, documented admin/schema",
  "operations first, and only use custom migrations or raw SQL for simple statements the API accepts.",
].join(" ");

export function applyDatabasePackPromptOverride(
  vendor: ResolveResult,
  task: SuiteTask,
  prompt: string,
): string {
  if (vendor.category !== "database") return prompt;
  if (vendor.slug === "insforge" && task.id.startsWith("db-")) {
    return `${prompt}\n\n${INSFORGE_API_SCHEMA_NOTE}`;
  }
  if (vendor.slug !== "convex") return prompt;
  if (!task.id.startsWith("db-")) return prompt;
  return [
    prompt,
    "",
    CONVEX_IDENTIFIER_NOTE,
    CONVEX_VERIFIER_CONTRACTS[task.id],
  ].filter(Boolean).join("\n\n");
}
