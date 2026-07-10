/**
 * Compose a TargetPack from a canonical Suite + a vendor's OracleExtract +
 * vendor card. Pure code — no LLM. Every per-vendor unknown (oracle paths,
 * base_url, auth) was already resolved by resolve-vendor / extract-oracles;
 * this step is template rendering + schema assembly.
 *
 * Task prompt text comes straight from the suite's `intent` field — it's
 * already vendor-agnostic goal language ("use the vendor's idiomatic
 * mechanism"), so no per-vendor rewriting is needed or wanted: the agent is
 * supposed to discover the concrete mechanism itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { newRunId, NS_PLACEHOLDER } from "./pack.js";
import type { Suite } from "./suite.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { OracleExtractResult } from "./task-extract.js";
import type { SurfaceExtractResult } from "./surface-extract.js";
import { CANONICAL_SURFACE_SCOPE, type SupportMatrix } from "./methodology.js";
import { TargetPackSchema, type TargetPack } from "../schemas.js";
import { applyDatabasePackPromptOverride, databaseSurfaceFallback } from "./database-pack-overrides.js";
import { daebCompiledPackPath } from "./benchmark-paths.js";

export interface ComposePackOptions {
  /** Generation provenance label recorded on the pack. */
  generatedBy?: string;
  /** CLI/SDK/MCP surface declarations — the round-trip oracle never changes
   *  per surface (verification always reads state back via REST/SQL), so
   *  this only affects how the agent is told to act on non-API surfaces. */
  surfaces?: SurfaceExtractResult;
  supportMatrix?: SupportMatrix;
}

function vendorSandboxScope(vendor: ResolveResult): TargetPack["sandbox_scope"] {
  if (vendor.slug === "neon") {
    return [
      {
        name: "project_id",
        env: "NEON_PROJECT_ID",
        required: true,
        instructions: "existing Neon sandbox project id; use this instead of creating a new project",
      },
      {
        name: "branch_id",
        env: "NEON_BRANCH_ID",
        required: false,
        instructions: "optional existing Neon sandbox branch id connected to NEON_DATABASE_URL; if unset, discover the branch from the project via the Neon API",
      },
    ];
  }
  if (vendor.slug === "nile") {
    return [
      {
        name: "workspace",
        env: "NILE_WORKSPACE",
        required: true,
        instructions: "existing free-tier Nile workspace; do not create or mutate other workspaces",
      },
      {
        name: "database",
        env: "NILE_DB",
        required: true,
        instructions: "disposable Nile database dedicated to DAEB namespaced resources; require NILE_DB to match the database name in NILE_DATABASE_URL",
      },
    ];
  }
  return [];
}

const NON_API_SURFACES = ["cli", "sdk", "mcp"] as const;

function assertDeclaredTaskSurfaces(pack: TargetPack): void {
  for (const surface of NON_API_SURFACES) {
    const taskIds = pack.tasks.filter((task) => task.allowed_surfaces.includes(surface)).map((task) => task.id);
    if (!taskIds.length) continue;
    if (pack.surfaces?.[surface]) continue;
    throw new Error(
      `compose-pack: ${pack.name} allows surface "${surface}" on task(s) ${taskIds.join(", ")} but is missing surfaces.${surface}`,
    );
  }
}

/** Compose one vendor's frozen TargetPack from suite + oracle extract + vendor card. */
export function composePack(
  suite: Suite,
  vendor: ResolveResult,
  extract: OracleExtractResult,
  opts: ComposePackOptions = {},
): TargetPack {
  const extractByTaskId = new Map(extract.tasks.map((t) => [t.task_id, t]));
  const surfaces = opts.surfaces ?? databaseSurfaceFallback(vendor, extract);

  const tasks = suite.tasks.map((suiteTask) => {
    const o = extractByTaskId.get(suiteTask.id);
    if (!o) {
      throw new Error(`compose-pack: oracle extract for "${vendor.vendor}" is missing task "${suiteTask.id}"`);
    }
    const basePrompt = suiteTask.intent.trim().replace(/\{ns\}/g, NS_PLACEHOLDER);
    const prompt = applyDatabasePackPromptOverride(vendor, suiteTask, basePrompt);
    if (o.na) {
      return {
        id: suiteTask.id,
        title: suiteTask.title,
        prompt,
        difficulty: suiteTask.difficulty,
        allowed_surfaces: [],
        na: true,
        oracles: [{ type: "na", description: o.na_reason ?? "marked N/A by oracle extract" }],
      };
    }
    if (!o.checks.length) {
      throw new Error(`compose-pack: task "${suiteTask.id}" for "${vendor.vendor}" has na=false but no checks`);
    }
    // Per-surface N/A: this task IS possible for the vendor, just not via
    // every surface (e.g. a JS SDK with no schema-DDL methods). Narrowing
    // allowed_surfaces here excludes it from that surface's execution AND
    // scoring (tasksForSurface filters by this), same as whole-task na —
    // just scoped to one surface.
    const naSurfaces = new Set<string>(o.na_surfaces);
    const supportEntries = opts.supportMatrix?.entries.filter((entry) => entry.vendor === vendor.vendor && entry.task_id === suiteTask.id) ?? [];
    // MCP disabled for v1 (see AXARENA_PLAN.md): each vendor's MCP server has
    // its own auth/transport conventions requiring per-vendor provisioning
    // work (already found and fixed one real stdio-vs-http bug here), signal
    // so far is thin (near-0% across both tested vendors), and claude-code's
    // MCP surface specifically requires a paid API key (subscription auth
    // can't reach the isolated home MCP testing needs). Revisit once MCP is
    // more uniformly mature across vendors — code path is untouched, just
    // excluded from the composed pack's allowed_surfaces.
    const DISABLED_SURFACES = new Set(["mcp"]);
    const methodologyScope = suite.methodology?.surface_scope ?? [...CANONICAL_SURFACE_SCOPE];
    const supportedFromMatrix = supportEntries.length
      ? new Set(supportEntries.filter((entry) => entry.status === "supported").map((entry) => entry.surface))
      : null;
    const allowedSurfaces = suiteTask.allowed_surfaces.filter((s) =>
      methodologyScope.includes(s as typeof CANONICAL_SURFACE_SCOPE[number]) &&
      !naSurfaces.has(s) &&
      !DISABLED_SURFACES.has(s) &&
      (!supportedFromMatrix || supportedFromMatrix.has(s as typeof CANONICAL_SURFACE_SCOPE[number]))
    );
    return {
      id: suiteTask.id,
      title: suiteTask.title,
      prompt,
      difficulty: suiteTask.difficulty,
      allowed_surfaces: allowedSurfaces,
      oracles: o.checks.map((check) => ({
        type: "roundtrip",
        description: check.description || suiteTask.oracle_hint.trim(),
        ...(check.sql_query
          ? {
              // Cosmetic field only — the verifier resolves the real
              // dialect from pack.sql_conn, set below from vendor_config.
              sqlDialect: check.sql_dialect ?? extract.vendor_config.sql_dialect,
              sqlQuery: check.sql_query.replace(/\{ns\}/g, NS_PLACEHOLDER),
              probeSqlQuery: check.probe_sql_query?.replace(/\{ns\}/g, NS_PLACEHOLDER),
              probeAssertField: check.probe_assert_field,
              probeExpected: typeof check.probe_expected === "string"
                ? check.probe_expected.replace(/\{ns\}/g, NS_PLACEHOLDER)
                : check.probe_expected,
              probeExpectError: check.probe_expect_error,
            }
          : check.mongo_query
            ? {
                mongoQuery: check.mongo_query,
              }
            : {
                readMethod: check.read_method,
                readPathTemplate: check.read_path_template?.replace(/\{ns\}/g, NS_PLACEHOLDER),
                readBodyTemplate: check.read_body_template,
              }),
        assertField: check.assert_field,
        expected:
          typeof check.expected === "string" ? check.expected.replace(/\{ns\}/g, NS_PLACEHOLDER) : check.expected,
        authField: check.auth_field,
        sqlConnField: check.sql_conn_field,
      })),
    };
  });
  const taskSurfaceSet = new Set(tasks.flatMap((task) => task.allowed_surfaces));

  const pack = {
    name: vendor.slug,
    version: "1",
    standard_set_version: `${suite.name.toLowerCase()}-v${suite.version}`,
    run_id: newRunId(),
    generated_by: opts.generatedBy ?? "suite-composed",
    generator: {
      harness: extract.vendor_config ? "claude-code" : "host-agent",
      model: "host-default",
      effort: "high" as const,
      prompt_version: "compose-pack-v1",
      source_docs: [vendor.docs_url ?? ""].filter(Boolean),
    },
    api_style: "rest" as const,
    auth_method: "pat" as const,
    auth: {
      type: extract.vendor_config.auth_type,
      env: extract.vendor_config.auth_env,
      env_aliases: [],
      verify_env_aliases: [],
      header: extract.vendor_config.auth_header,
      extra_header: extract.vendor_config.extra_auth_header,
    },
    sandbox_scope: vendorSandboxScope(vendor),
    surfaces: surfaces
      ? {
          ...(surfaces.cli && taskSurfaceSet.has("cli")
            ? { cli: { bin: surfaces.cli.bin, install: surfaces.cli.install, help: surfaces.cli.help, docs_url: surfaces.cli.docs_url, auth: surfaces.cli.auth } }
            : {}),
          ...(surfaces.sdk && taskSurfaceSet.has("sdk")
            ? { sdk: { package: surfaces.sdk.package, language: surfaces.sdk.language, install: surfaces.sdk.install, reference_url: surfaces.sdk.reference_url, auth: surfaces.sdk.auth } }
            : {}),
          // mcp surface disabled for v1 — see DISABLED_SURFACES above.
          // Deliberately not declaring surfaces.mcp even when extracted, so
          // an accidental `--surface mcp` invocation fails loudly (no
          // provisioning info) rather than silently running.
        }
      : undefined,
    sql_conn:
      extract.vendor_config.sql_dialect && extract.vendor_config.sql_connection_env
        ? { dialect: extract.vendor_config.sql_dialect, connection_string_env: extract.vendor_config.sql_connection_env }
        : undefined,
    mongo_conn:
      extract.vendor_config.mongo_connection_env
        ? { connection_string_env: extract.vendor_config.mongo_connection_env, database: extract.vendor_config.mongo_database }
        : undefined,
    base_url: extract.vendor_config.base_url,
    headers: {},
    site_url: vendor.site_url ?? "",
    docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
    static: {
      site_url: vendor.site_url ?? "",
      docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
      checks: [],
    },
    tasks,
  };

  const parsed = TargetPackSchema.parse(pack);
  assertDeclaredTaskSurfaces(parsed);
  return parsed;
}

/** Path where a composed pack is written (DAEB v1 layout uses pack.yaml). */
export function composedPackPath(root: string, slug: string, _suiteName: string): string {
  return daebCompiledPackPath(root, slug);
}

/** Write a composed pack to disk as YAML. */
export function writeComposedPack(root: string, slug: string, suiteName: string, pack: TargetPack): string {
  const path = composedPackPath(root, slug, suiteName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# GENERATED — frozen standard_set. Do not hand-edit task ids/oracles after freeze.\n` +
      `# generated_by: ${pack.generated_by}\n` +
      `# standard_set_version: ${pack.standard_set_version}\n` +
      `# run_id: ${pack.run_id}\n` +
      yamlStringify(pack),
  );
  return path;
}
