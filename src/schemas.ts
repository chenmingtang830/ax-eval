/**
 * The four core schemas: Task, TargetPack, the harness
 * Adapter, and RunResult — plus the OracleSpec/OracleResult that make success
 * legible. Defined with zod so a target pack's YAML is validated on load.
 *
 * Adapters take a Task + TargetPack and return a RunResult. Oracles score the
 * "world state" an adapter reports, so mock and live adapters are interchangeable.
 */
import { z } from "zod";

/** A declarative check attached to a task. `type` selects the oracle impl;
 *  `path` addresses a value in the reported world state (dotted keys).
 *
 *  The `roundtrip` type is the generated T1 oracle: after the executor creates
 *  a resource and reports its id, the verifier GETs `readPathTemplate` (with
 *  `{gid}` substituted), strips `responseEnvelope`, and asserts the dotted
 *  `assertField` equals `expected`. It is independent of the executor (the id
 *  is reported, but the field read-back + comparison happen against the real
 *  API), which is what makes it a legitimate programmatic check. */
export const OracleSpecSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  expected: z.unknown().optional(),
  /** Additional acceptable expected values. Used when a product can return
   *  several canonical-equivalent URLs or versioned documentation aliases. */
  expectedAny: z.array(z.unknown()).optional(),
  /** Comparison mode for round-trip assertions. `exact` is the default; `url`
   *  normalizes harmless URL differences such as hashes and trailing slashes. */
  matchMode: z.enum(["exact", "url"]).optional(),
  value: z.unknown().optional(),
  description: z.string().default(""),
  // roundtrip-only fields (ignored by exists/equals/contains)
  /** REST round-trip read method. Defaults to GET for existing packs; POST lets
   *  stateless/read APIs verify through a live read endpoint such as /contents. */
  readMethod: z.enum(["GET", "POST"]).optional(),
  readPathTemplate: z.string().optional(),
  /** JSON body template for POST read-back. String leaves may contain {gid}. */
  readBodyTemplate: z.unknown().optional(),
  /** GraphQL round-trip read: a query string with a `{gid}` placeholder. Used
   *  instead of `readPathTemplate` when the pack's `api_style` is "graphql".
   *  The verifier substitutes `{gid}`, POSTs the query, and resolves the dotted
   *  `assertField` against the returned `data` object. */
  readQueryTemplate: z.string().optional(),
  responseEnvelope: z.string().optional(),
  assertField: z.string().optional(),
  /** `value` is the default read-back assertion. `error` requires the SQL or
   * HTTP operation itself to fail with the expected error field/code. */
  assertOutcome: z.enum(["value", "error"]).optional(),
  expectedHttpStatuses: z.array(z.number().int()).optional(),
  /** SQL wire-protocol round-trip: for vendors with no REST query endpoint
   *  (e.g. CockroachDB, PlanetScale), the verifier opens a real DB
   *  connection (via TargetPack.sql_conn), runs `sqlQuery`, and resolves
   *  the dotted `assertField` against the first result row. */
  sqlDialect: z.enum(["postgres", "mysql"]).optional(),
  sqlQuery: z.string().optional(),
  /** Optional verifier-issued SQL mutation/read before the main round-trip
   * assertion. Must be namespace-scoped; used for conflict/deny probes. */
  probeSqlQuery: z.string().optional(),
  probeAssertField: z.string().optional(),
  probeExpected: z.unknown().optional(),
  probeExpectedAny: z.array(z.unknown()).optional(),
  /** Require probe execution to return an error object rather than rows. */
  probeExpectError: z.boolean().optional(),
  /** MongoDB Atlas round-trip read: verifier opens TargetPack.mongo_conn and
   *  runs a small declarative read operation against a collection. */
  mongoQuery: z.object({
    database: z.string(),
    collection: z.string(),
    operation: z.enum(["count", "findOne", "aggregate", "listCollections"]),
    filter: z.unknown().optional(),
    projection: z.unknown().optional(),
    sort: z.unknown().optional(),
    pipeline: z.array(z.unknown()).optional(),
  }).optional(),
  /** Identity-scoped (e.g. row-level security) round-trip: the key the
   *  executor reports THIS check's Bearer credential under (alongside
   *  `gid`), e.g. "user_a_token". The verifier authenticates as that
   *  identity instead of the pack's default — needed because the pack's
   *  admin-level credential typically bypasses row-level security. */
  authField: z.string().optional(),
  /** Identity-scoped (SQL variant): the key the executor reports THIS
   *  check's full alternate connection string under (alongside `gid`),
   *  e.g. "restored_connection_string" or "reader_connection_string" —
   *  needed when the resource to verify lives behind a DIFFERENT
   *  credential than the pack's default sql_conn (e.g. a new branch
   *  created during restore, or a scoped role created for RBAC testing).
   *  The executor already has this connection string in hand (it's what
   *  it just used to do the work); this only asks it to also report it. */
  sqlConnField: z.string().optional(),
  /** Identity-scoped SQL verifier role reported by the executor. The verifier
   * switches to it on the pack's admin connection before executing the check. */
  sqlRoleField: z.string().optional(),
  /** Deterministic SQL role name template. `{ns}` is rendered as a
   * SQL-identifier-safe namespace before the verifier issues SET ROLE. */
  sqlRoleTemplate: z.string().optional(),
});
export type OracleSpec = z.infer<typeof OracleSpecSchema>;

/** Optional structural expectations over the executor trace. These are local,
 *  best-effort constraints: they verify that the agent attempted the expected
 *  shape of API interaction, while round-trip oracles still decide success. */
export const TraceConstraintSchema = z.object({
  type: z.enum(["required_call", "forbidden_call", "order"]).default("required_call"),
  taskId: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  description: z.string().default(""),
});
export type TraceConstraint = z.infer<typeof TraceConstraintSchema>;

/** A concrete goal an agent must achieve against the target. `title` is
 *  optional and falls back to `id` (matching the original loader's behavior),
 *  so a minimal task (id + prompt + oracles) is still valid. */
export const TaskSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    prompt: z.string().default(""),
    oracles: z.array(OracleSpecSchema).default([]),
    /** Difficulty tier (L1 single-op floor … L4 hard scenario). Drives the
     *  by-difficulty breakdown in the report; difficulty comes from what the
     *  executor is told, not from how success is checked. */
    difficulty: z.enum(["L1", "L2", "L3", "L4"]).default("L1"),
    /** Surfaces the executor is allowed to use this task (e.g. ["docs"] hides
     *  the OpenAPI spec to force discovery). Empty = unrestricted. */
    allowed_surfaces: z.array(z.string()).default([]),
    /** True when this task is structurally impossible for the vendor on ANY
     *  surface (e.g. no backup API at all) — excluded from execution (the
     *  executor is never asked to attempt it) and from scoring's denominator.
     *  Distinct from allowed_surfaces=[] which means "unrestricted" for
     *  ordinary tasks, not "never runs" — this flag is unambiguous. */
    na: z.boolean().optional().transform((v) => v ?? false),
    /** Generated-task scaffolding the executor and verifier need at run time. */
    create_path: z.string().optional(),
    create_envelope: z.string().optional(),
    depends_on: z.array(z.string()).default([]),
    /** Optional expected/forbidden trace constraints for structural diff. */
    trace: z.array(TraceConstraintSchema).default([]),
  })
  .transform((t) => ({ ...t, title: t.title ?? t.id }));
export type Task = z.infer<typeof TaskSchema>;

/** A frozen static-check scope, versioned alongside the behavioral set so the
 *  static score is reproducible and comparable across runs. */
export const StaticScopeSchema = z.object({
  site_url: z.string().default(""),
  docs_urls: z.array(z.string()).default([]),
  /** Check ids to include; empty = the default checklist (src/static/checks). */
  checks: z.array(z.string()).default([]),
});
export type StaticScope = z.infer<typeof StaticScopeSchema>;

/** Cold-start discovery probe — the behavioral AEO layer. Unlike L1-L4 (which
 *  inject the endpoint or docs), discovery hands the agent ONLY the product name
 *  + a natural-language goal + creds, and observes its real search→land→read→
 *  extract funnel. Scored against what the official docs *should* let it find. */
export const DiscoverySpecSchema = z.object({
  /** Product the agent is told to use (e.g. "Asana"). */
  product: z.string().default(""),
  /** Natural-language goal, no endpoint/spec leaked. */
  goal: z.string().default(""),
  /** Hostnames that count as "official" (developers.asana.com, asana.com). */
  official_domains: z.array(z.string()).default([]),
  /** The current/correct call, e.g. "POST /tasks" — for the canonical check. */
  canonical_endpoint: z.string().default(""),
  /** Substrings that signal an outdated/wrong path (old hosts, deprecated ops). */
  deprecated_markers: z.array(z.string()).default([]),
  /** Human label of the expected auth scheme, e.g. "Bearer personal access token". */
  auth_scheme: z.string().default(""),
  /** Round-trip oracle confirming the goal was actually achieved. */
  outcome: OracleSpecSchema.optional(),
});
export type DiscoverySpec = z.infer<typeof DiscoverySpecSchema>;

/** Per-surface descriptors. AX eval measures the SAME tasks across the surfaces
 *  an agent can drive a product through (api/sdk/mcp/cli). The `api` surface is
 *  always available (it's `base_url` + `auth`); the optional blocks below declare
 *  the *other* surfaces a product exposes, so a run can target one or fan out to
 *  `all`. None of these change the round-trip oracle — verification always reads
 *  the created resource back via the API, regardless of how it was created. */
/** How a non-API surface authenticates. The credential itself never lives in the
 *  pack — only the env-var *names* do. `kind` decides what the harness needs and
 *  what "blocked" state a missing credential maps to:
 *   - "inherit": reuse the top-level API credential (`auth.env`). For SDKs/CLIs
 *      that wrap the same REST API with the same token (e.g. the `asana` SDK).
 *   - "token": this surface needs its OWN token in `token_env` (e.g. a separate
 *      MCP-server token). Missing → cube cell `blocked: missing-credential`.
 *   - "oauth_app": no headless token path — the surface requires a pre-registered
 *      OAuth app (client id/secret) + a stored refresh token. Until all three are
 *      set the cell is `blocked: requires-oauth` (never a misleading 0%). */
export const SurfaceAuthSchema = z.object({
  kind: z.enum(["inherit", "token", "oauth_app"]).default("inherit"),
  /** Env var holding this surface's own token (kind="token"). */
  token_env: z.string().optional(),
  /** Back-compat aliases accepted for `token_env`. The first name remains the
   *  canonical key shown in prompts and generated packs. */
  token_env_aliases: z.array(z.string()).default([]),
  /** OAuth app credentials (kind="oauth_app"). */
  client_id_env: z.string().optional(),
  client_secret_env: z.string().optional(),
  refresh_token_env: z.string().optional(),
  /** OAuth token endpoint used to exchange the refresh token for a short-lived
   *  bearer token before invoking a headless harness. */
  token_url: z.string().url().optional(),
  /** What the developer must do to provision these (shown by check-env / init). */
  instructions: z.string().optional(),
});
export type SurfaceAuth = z.infer<typeof SurfaceAuthSchema>;

export const CliSurfaceSchema = z.object({
  /** The CLI binary an agent must drive (e.g. "asana", "gh", "linear"). */
  bin: z.string(),
  /** How to install it, shown in the prompt's setup block (e.g. "npm i -g @x/cli"). */
  install: z.string().optional(),
  /** The help entrypoint the agent should inspect (default "<bin> --help"). */
  help: z.string().optional(),
  /** Official CLI docs URL (an authoritative discovery source). */
  docs_url: z.string().optional(),
  /** Per-surface auth (defaults to inheriting the API credential). */
  auth: SurfaceAuthSchema.optional(),
});
export type CliSurface = z.infer<typeof CliSurfaceSchema>;

export const SdkSurfaceSchema = z.object({
  /** The package an agent must install + call (e.g. "@notionhq/client"). */
  package: z.string(),
  /** Language/runtime of the SDK (default "node"). */
  language: z.string().default("node"),
  /** How to install it (default derived from package + language). */
  install: z.string().optional(),
  /** SDK reference URL (an authoritative discovery source). */
  reference_url: z.string().optional(),
  /** Per-surface auth (defaults to inheriting the API credential). */
  auth: SurfaceAuthSchema.optional(),
});
export type SdkSurface = z.infer<typeof SdkSurfaceSchema>;

const McpExecutableSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/,
  "stdio MCP server must be a single executable name; put arguments in args",
);
const McpArgumentSchema = z.string().min(1).refine(
  (value) => !/[\0\n\r]/.test(value),
  "stdio MCP arguments must not contain null bytes or newlines",
);

export const McpSurfaceSchema = z.object({
  /** Server command (stdio) or URL (http) the agent's MCP client connects to. */
  server: z.string(),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  /** Stdio argv. Shell command strings are intentionally unsupported. */
  args: z.array(McpArgumentSchema).default([]),
  /** How to register/configure the server, shown in the prompt's setup block. */
  setup: z.string().optional(),
  /** MCP docs URL (an authoritative discovery source). */
  docs_url: z.string().optional(),
  /** Optional per-tool approval overrides for headless clients that distinguish
   *  read vs write tools at the MCP layer (e.g. Stripe's `stripe_api_write`). */
  tool_approval_mode: z.record(z.string(), z.enum(["auto", "prompt", "approve"])).optional(),
  /** Per-surface auth. Hosted OAuth-only servers (Asana/Notion) set
   *  kind="oauth_app"; token-friendly servers (Monday/Linear) set kind="token". */
  auth: SurfaceAuthSchema.optional(),
}).superRefine((mcp, context) => {
  if (mcp.transport === "stdio" && !McpExecutableSchema.safeParse(mcp.server).success) {
    context.addIssue({
      code: "custom",
      path: ["server"],
      message: "stdio MCP server must be a single executable name; put arguments in args",
    });
  }
  if (mcp.transport === "stdio" && mcp.auth?.kind === "oauth_app") {
    context.addIssue({
      code: "custom",
      path: ["auth", "kind"],
      message: "stdio MCP servers must use inherit or token auth",
    });
  }
  if (mcp.transport === "http" && mcp.args.length > 0) {
    context.addIssue({ code: "custom", path: ["args"], message: "http MCP servers must not declare args" });
  }
});
export type McpSurface = z.infer<typeof McpSurfaceSchema>;

/** The non-API surfaces this target exposes. Absent blocks = surface unavailable
 *  (so `--surface all` only fans out to what's declared). Deliberately excluded
 *  from the review hash (see generate/review.ts): declaring a surface doesn't
 *  change what tasks an agent is authorized to run. */
export const SurfaceConfigSchema = z.object({
  cli: CliSurfaceSchema.optional(),
  sdk: SdkSurfaceSchema.optional(),
  mcp: McpSurfaceSchema.optional(),
});
export type SurfaceConfig = z.infer<typeof SurfaceConfigSchema>;

/** How the agent authenticates to the target. The credential itself lives in an
 *  env var (never in the pack); the pack only names the var + the scheme, so the
 *  runner is target-agnostic. `verify_env` is an optional narrower oracle key. */
export const AuthSchema = z.object({
  type: z.enum(["bearer", "api-key", "oauth", "none"]).default("bearer"),
  /** Env var holding the agent's credential, e.g. ASANA_PAT. */
  env: z.string().default(""),
  /** Back-compat aliases accepted for `env`. The first name remains canonical. */
  env_aliases: z.array(z.string()).default([]),
  /** Optional separate (narrower) credential for the verification oracle. */
  verify_env: z.string().optional(),
  /** Back-compat aliases accepted for `verify_env`. */
  verify_env_aliases: z.array(z.string()).default([]),
  /** Header name for the credential (default by type: bearer/api-key → Authorization). */
  header: z.string().optional(),
  /** Some APIs require the SAME credential sent under a second header name in
   *  addition to the primary auth header — e.g. Supabase's PostgREST rejects
   *  `Authorization: Bearer <key>` alone with "No API key found in request"
   *  unless `apikey: <key>` is also present. */
  extra_header: z.string().optional(),
});
export type Auth = z.infer<typeof AuthSchema>;

/** One sandbox-isolation parameter the developer must provision + provide. The
 *  *level* differs per product (Stripe = test account → none; Asana = workspace
 *  + project; GitHub = repo), so each pack declares its own. Values come from env
 *  (and may be pasted as a URL the `url_pattern` extracts an id from). */
export const ScopeParamSchema = z.object({
  /** Logical name used in instructions/templates, e.g. "project_gid". */
  name: z.string(),
  /** Env var holding the value, e.g. ASANA_SANDBOX_PROJECT_GID. */
  env: z.string(),
  required: z.boolean().default(true),
  /** What the developer must do to provision it (shown by check-env / the skill). */
  instructions: z.string().default(""),
  /** Optional regex (one capture group) to pull the id from a pasted URL. */
  url_pattern: z.string().optional(),
});
export type ScopeParam = z.infer<typeof ScopeParamSchema>;

export const GeneratorProvenanceSchema = z.object({
  harness: z.string().default("host-agent"),
  model: z.string().default("host-default"),
  effort: z.enum(["low", "medium", "high"]).default("high"),
  prompt_version: z.string().default("ax-eval-generator-v1"),
  source_docs: z.array(z.string()).default([]),
});
export type GeneratorProvenance = z.infer<typeof GeneratorProvenanceSchema>;

/** Versioned bundle describing a target and its task set. */
export const TargetPackSchema = z.object({
  name: z.string(),
  version: z.coerce.string().default("0"),
  /** Version of the frozen standard set (tasks + oracles + static scope). */
  standard_set_version: z.string().default(""),
  /** Frozen generation version tag (e.g. 2026-06-02-joaufx). Identifies the
   *  standard_set; NOT part of resource names (those carry a per-execution
   *  `{ns}` placeholder resolved per harness × attempt). */
  run_id: z.string().default(""),
  /** Coarse provenance of generation (`llm-assisted` by default,
   *  `deterministic@no-model` for the rule-derived fallback). Generation
   *  harness ≠ execution harness — recorded so a score is never confused with
   *  who authored it. */
  generated_by: z.string().default(""),
  /** Optional authoring provenance for LLM-assisted generation. Frozen packs are
   *  still reviewed/hash-locked before execution; this records who authored the
   *  draft, not who executed it. */
  generator: GeneratorProvenanceSchema.optional(),
  auth_method: z.string().default("none"),
  /** API style of the target. "rest" (default) keeps Asana/Notion unchanged:
   *  the round-trip oracle does `GET readPathTemplate`. "graphql" routes the
   *  round-trip read through a single endpoint via `OracleSpec.readQueryTemplate`
   *  (Linear/Monday — one POST endpoint, hand-authored read-back queries). */
  api_style: z.enum(["rest", "graphql"]).default("rest"),
  /** Declarative auth (target-agnostic). When absent, the runner falls back to
   *  legacy Asana env vars so existing packs keep working. */
  auth: AuthSchema.optional(),
  /** Sandbox-isolation parameters the developer provisions (level varies by
   *  product). Empty = a single account/key is the whole sandbox (e.g. Stripe). */
  sandbox_scope: z.array(ScopeParamSchema).default([]),
  /** Connection info for `OracleSpec.sqlQuery` checks — vendors whose data
   *  plane is only reachable over the raw Postgres/MySQL wire protocol (no
   *  REST query endpoint), e.g. CockroachDB, PlanetScale. Absent when the
   *  pack has no SQL-form oracles. */
  sql_conn: z
    .object({
      dialect: z.enum(["postgres", "mysql"]),
      /** Env var holding a full connection string/DSN. */
      connection_string_env: z.string(),
    })
    .optional(),
  mongo_conn: z
    .object({
      /** Env var holding a full MongoDB connection string. */
      connection_string_env: z.string(),
      /** Default database used by MongoDB oracle checks. */
      database: z.string().optional(),
    })
    .optional(),
  /** Non-API surfaces this target exposes (cli/sdk/mcp). The API surface is
   *  always available via `base_url`/`auth`. Drives `--surface` fan-out. */
  surfaces: SurfaceConfigSchema.optional(),
  base_url: z.string().default(""),
  /** Request/response envelope key (e.g. Asana wraps bodies in `data`). */
  request_envelope: z.string().optional(),
  response_envelope: z.string().optional(),
  /** Constant headers every API request must carry (target-agnostic). E.g.
   *  Notion requires `Notion-Version`. Auth headers are handled by `auth`. */
  headers: z.record(z.string()).default({}),
  /** Query param a GET uses to select fields (Asana: `opt_fields`). When unset,
   *  the round-trip read sends no field-selection param (e.g. Notion). */
  field_select_param: z.string().optional(),
  /** The product's public website/docs root, e.g. https://asana.com — the
   *  starting point for the static (agent-readiness / AEO) audit. */
  site_url: z.string().default(""),
  /** The OpenAPI spec URL the content-quality (v3 smell) audit reads. Empty =
   *  the audit is skipped for this target. Populated automatically by the pack
   *  generator from the ingested spec's source. */
  openapi_url: z.string().default(""),
  docs_urls: z.array(z.string()).default([]),
  static: StaticScopeSchema.optional(),
  /** Optional cold-start discovery probe (behavioral AEO). */
  discovery: DiscoverySpecSchema.optional(),
  tasks: z.array(TaskSchema).default([]),
}).superRefine((pack, context) => {
  const mcp = pack.surfaces?.mcp;
  const inheritsHttpAuth = mcp?.transport === "http" && (!mcp.auth || mcp.auth.kind === "inherit");
  if (inheritsHttpAuth && pack.auth && pack.auth.type !== "bearer" && pack.auth.type !== "none") {
    context.addIssue({
      code: "custom",
      path: ["surfaces", "mcp", "auth", "kind"],
      message: "HTTP MCP inherit auth requires top-level bearer or none auth",
    });
  }
});
export type TargetPack = z.infer<typeof TargetPackSchema>;

/** The outcome of evaluating a single oracle. */
export interface OracleResult {
  type: string;
  passed: boolean;
  detail: string;
}

/** The record of one task × harness run. */
export interface RunResult {
  taskId: string;
  harness: string;
  success: boolean;
  oracleResults: OracleResult[];
  trace: string[];
  durationMs: number;
  error: string | null;
}

/** Flat-ish reported world state; oracle paths resolve against nested objects. */
export type World = Record<string, unknown>;
