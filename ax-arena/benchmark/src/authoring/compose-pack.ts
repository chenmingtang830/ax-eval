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
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  CANONICAL_SURFACE_SCOPE,
  NS_PLACEHOLDER,
  TargetPackSchema,
  assertCanonicalDaebWritePath,
  newRunId,
  type DaebPathInput,
  type OracleExtractResult,
  type Suite,
  type SupportMatrix,
  type SurfaceExtractResult,
  type TargetPack,
} from "ax-eval";
import {
  applyDatabasePackPromptOverride,
  databaseDiscoverySpec,
  databaseSurfaceFallback,
  type DatabasePackVendor,
} from "./database-pack-overrides.js";

export interface ComposePackOptions {
  /** Generation provenance label recorded on the pack. */
  generatedBy?: string;
  /** CLI/SDK/MCP surface declarations — the round-trip oracle never changes
   *  per surface (verification always reads state back via REST/SQL), so
   *  this only affects how the agent is told to act on non-API surfaces. */
  surfaces?: SurfaceExtractResult;
  supportMatrix?: SupportMatrix;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a single safe path segment: ${value}`);
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonicalWriteRoot(input: DaebPathInput): { repositoryRoot: string; writeRoot: string } {
  const repositoryRoot = resolve(typeof input === "string" ? input : input.repositoryRoot);
  const writeRoot = resolve(repositoryRoot, "ax-arena", "benchmark", "daeb");
  if (typeof input !== "string" && resolve(input.writeRoot) !== writeRoot) {
    throw new Error(`DAEB path context write root must be canonical: ${writeRoot}`);
  }
  return { repositoryRoot, writeRoot };
}

function assertRealDirectory(path: string, label: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory and cannot traverse a symlink: ${path}`);
  }
  return stat;
}

function entryIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureRealParent(repositoryRoot: string, parent: string): Stats {
  if (!contained(repositoryRoot, parent)) {
    throw new Error(`composed pack parent must stay inside repository root: ${parent}`);
  }
  assertRealDirectory(repositoryRoot, "repository root");
  const path = relative(repositoryRoot, parent);
  let current = repositoryRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    assertRealDirectory(current, "composed pack parent");
  }
  return assertRealDirectory(parent, "composed pack parent");
}

interface ComposedPackWriteHooks {
  beforeTempOpen?: (context: { parent: string; path: string }) => void;
  write?: (descriptor: number, contents: string) => void;
  beforeCommit?: (context: { parent: string; path: string; tempPath: string }) => void;
}

function assertStableParent(parent: string, expected: Stats, descriptor: number): void {
  const byPath = lstatSync(parent);
  const opened = fstatSync(descriptor);
  if (byPath.isSymbolicLink() || !byPath.isDirectory()
    || !sameInode(byPath, expected) || !sameInode(opened, expected)) {
    throw new Error(`composed pack parent changed during atomic write: ${parent}`);
  }
}

function assertStableTarget(path: string, expected: Stats | undefined): void {
  const current = entryIfPresent(path);
  if (!expected) {
    if (current) throw new Error(`composed pack output appeared during atomic write: ${path}`);
    return;
  }
  if (!current || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
    || !sameInode(current, expected)) {
    throw new Error(`composed pack output changed during atomic write: ${path}`);
  }
}

function assertStableTemporary(path: string, descriptor: number): Stats {
  const opened = fstatSync(descriptor);
  const current = lstatSync(path);
  if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
    || !current.isFile() || current.nlink !== 1 || !sameInode(opened, current)) {
    throw new Error(`composed pack temporary output changed during atomic write: ${path}`);
  }
  return opened;
}

function unlinkSameInode(path: string, expected: Stats | undefined): void {
  if (!expected) return;
  const current = entryIfPresent(path);
  if (current && !current.isSymbolicLink() && sameInode(current, expected)) unlinkSync(path);
}

function writeComposedPackFile(
  path: string,
  repositoryRoot: string,
  contents: string,
  hooks: ComposedPackWriteHooks = {},
): void {
  const parent = dirname(path);
  const parentBefore = ensureRealParent(repositoryRoot, parent);
  const existing = entryIfPresent(path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error(`composed pack output must be a regular, single-link non-symlink file: ${path}`);
  }

  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let descriptor: number | undefined;
  let temporary: Stats | undefined;
  let tempPath: string | undefined;
  let committed = false;
  try {
    assertStableParent(parent, parentBefore, parentDescriptor);
    hooks.beforeTempOpen?.({ parent, path });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      tempPath = resolve(parent, `.${basename(path)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
      try {
        descriptor = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (descriptor === undefined || tempPath === undefined) {
      throw new Error(`could not reserve a unique composed pack temporary file: ${path}`);
    }
    temporary = fstatSync(descriptor);
    assertStableParent(parent, parentBefore, parentDescriptor);
    assertStableTemporary(tempPath, descriptor);
    assertStableTarget(path, existing);

    hooks.write ? hooks.write(descriptor, contents) : writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
    fsyncSync(descriptor);

    hooks.beforeCommit?.({ parent, path, tempPath });
    assertStableParent(parent, parentBefore, parentDescriptor);
    temporary = assertStableTemporary(tempPath, descriptor);
    assertStableTarget(path, existing);
    renameSync(tempPath, path);
    committed = true;

    assertStableParent(parent, parentBefore, parentDescriptor);
    const installed = lstatSync(path);
    if (installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1
      || !sameInode(installed, temporary)) {
      throw new Error(`composed pack output changed during atomic installation: ${path}`);
    }
    fsyncSync(parentDescriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!committed && tempPath) unlinkSameInode(tempPath, temporary);
    closeSync(parentDescriptor);
  }
}

/** Test-only fault injection for the atomic pack writer; not exported by the package root. */
export function writeComposedPackFileForTest(
  path: string,
  repositoryRoot: string,
  contents: string,
  hooks: ComposedPackWriteHooks,
): void {
  writeComposedPackFile(path, repositoryRoot, contents, hooks);
}

function vendorSandboxScope(vendor: DatabasePackVendor): TargetPack["sandbox_scope"] {
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
  vendor: DatabasePackVendor,
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
    if (o.na) {
      const prompt = applyDatabasePackPromptOverride(vendor, suiteTask, basePrompt, []);
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
    const prompt = applyDatabasePackPromptOverride(vendor, suiteTask, basePrompt, allowedSurfaces);
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
        assertOutcome: check.assert_outcome,
        expectedHttpStatuses: check.expected_http_statuses,
        expected:
          typeof check.expected === "string" ? check.expected.replace(/\{ns\}/g, NS_PLACEHOLDER) : check.expected,
        authField: check.auth_field,
        sqlConnField: check.sql_conn_field,
        sqlRoleField: check.sql_role_field,
        sqlRoleTemplate: check.sql_role_template,
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
    openapi_url: vendor.openapi_url ?? "",
    docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
    static: {
      site_url: vendor.site_url ?? "",
      docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
      // Empty checks → default static checklist (v0) when verify-generated audits.
      checks: [],
    },
    discovery: databaseDiscoverySpec(vendor, extract),
    tasks,
  };

  const parsed = TargetPackSchema.parse(pack);
  assertDeclaredTaskSurfaces(parsed);
  return parsed;
}

/** Path where a composed pack is written (DAEB v1 layout uses pack.yaml). */
export function composedPackPath(root: DaebPathInput, slug: string, _suiteName: string): string {
  const { writeRoot } = canonicalWriteRoot(root);
  const path = resolve(writeRoot, "v1", "packs", safeSegment(slug, "vendor slug"), "pack.yaml");
  return assertCanonicalDaebWritePath(root, path);
}

/** Write a composed pack to disk as YAML. */
export function writeComposedPack(root: DaebPathInput, slug: string, suiteName: string, pack: TargetPack): string {
  const path = composedPackPath(root, slug, suiteName);
  const { repositoryRoot } = canonicalWriteRoot(root);
  writeComposedPackFile(
    path,
    repositoryRoot,
    `# GENERATED — frozen standard_set. Do not hand-edit task ids/oracles after freeze.\n` +
      `# generated_by: ${pack.generated_by}\n` +
      `# standard_set_version: ${pack.standard_set_version}\n` +
      `# run_id: ${pack.run_id}\n` +
      yamlStringify(pack),
  );
  return path;
}
