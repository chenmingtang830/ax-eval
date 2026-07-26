import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  approvalPath,
  checkCellApproval,
  checkCommittedLegacyCellApproval,
  loadPack,
  packFileContentHash,
  redactSensitiveText,
  resolveRuntimeExtensions,
  runCell,
  type EvaluationCell,
  type NormalizedCellRecord,
  type ResetEvidence,
  type ResetPlan,
  type RuntimeExtensionRegistry,
  type SurfaceId,
  type TargetPack,
} from "ax-eval";
import { createBubblewrapSandbox, type BubblewrapSandboxConfig } from "./sandbox.js";
import {
  ARENA_CELL_CLEANUP_SCHEMA,
  ArenaCellCleanupSchema,
  ArenaExecutionModeSchema,
  type ArenaExecutionMode,
  type ArenaCellCleanupRecord,
} from "./schemas.js";

export { ARENA_CELL_CLEANUP_SCHEMA, ArenaCellCleanupSchema } from "./schemas.js";
export type { ArenaCellCleanupRecord } from "./schemas.js";

const SOURCE_PATHS = [
  ".git",
  ".hg",
  ".svn",
  ".github",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "schemas",
  "targets",
  "tests",
  "ax-arena/benchmark",
] as const;

export interface ArenaCellSpec {
  cwd: string;
  artifactDir: string;
  recordPath: string;
  cleanupPath: string;
  packPath: string;
  batchId: string;
  evaluationSetId: string;
  targetId: string;
  surface: SurfaceId;
  harness: "codex" | "claude-code";
  profile: "low" | "medium" | "high";
  model: string;
  effort: "low" | "medium" | "high";
  trial: number;
  sourceCommitSha: string;
  invokeTimeoutMs: number;
  firstActionTimeoutMs: number;
  invokeRetries: number;
  skipReset: boolean;
}

export interface ArenaCellExecution {
  cell: EvaluationCell;
  pack: TargetPack;
  credentialNames: {
    host: string[];
    verification: string[];
    reset: string[];
  };
  record: NormalizedCellRecord;
  recordPath: string;
  cleanup: ArenaCellCleanupRecord;
  cleanupPath: string;
}

export interface ArenaCellDependencies {
  credentials: Readonly<Record<string, string | undefined>>;
  now(): Date;
  runCell?(
    cell: EvaluationCell,
    options: Parameters<typeof runCell>[1],
  ): Promise<NormalizedCellRecord>;
  createRegistry(cell: EvaluationCell, pack: TargetPack): Promise<RuntimeExtensionRegistry>;
  execution?: ArenaExecutionMode;
  sandbox?: BubblewrapSandboxConfig;
}

type ArenaCellIdentity = Pick<
  ArenaCellSpec,
  | "batchId"
  | "evaluationSetId"
  | "targetId"
  | "surface"
  | "harness"
  | "profile"
  | "model"
  | "effort"
  | "trial"
  | "sourceCommitSha"
>;

export function arenaCellId(identity: ArenaCellIdentity, packContentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(packContentHash)) throw new Error("cell identity requires a full pack SHA-256");
  const prefix = `${identity.batchId}-${identity.targetId}-${identity.surface}-${identity.harness}-t${identity.trial}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "cell";
  const digest = createHash("sha256").update(JSON.stringify([
    identity.batchId,
    identity.evaluationSetId,
    identity.targetId,
    identity.surface,
    identity.harness,
    identity.profile,
    identity.model,
    identity.effort,
    identity.trial,
    identity.sourceCommitSha,
    packContentHash,
  ])).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function relativeInside(root: string, path: string, label: string): string {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || isRelativePathEscape(rel)) {
    throw new Error(`${label} must resolve inside the controller workspace`);
  }
  return rel;
}

/** Shared lexical containment primitive for controller and later batch paths. */
export function isRelativePathEscape(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertSafeParentChain(root: string, path: string, label: string): void {
  const rootPath = resolve(root);
  const rootStat = lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const rel = relativeInside(rootPath, path, label);
  let current = rootPath;
  for (const segment of dirname(rel).split(/[\\/]/).filter((entry) => entry && entry !== ".")) {
    current = resolve(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} parent must be a real directory: ${current}`);
    }
  }
}

export function assertArenaOutputRoot(cwd: string, outputRoot: string): void {
  assertRepositoryRoot(cwd);
  const outputRelative = relativeInside(cwd, outputRoot, "arena output root");
  assertSafeParentChain(cwd, outputRoot, "arena output root");
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  }).toString("utf8").split("\0").filter(Boolean);
  const protectedRoots = new Set<string>([
    ...SOURCE_PATHS,
    ...tracked.map((path) => path.split("/")[0]!),
  ]);
  for (const sourcePath of protectedRoots) {
    const protectedPath = resolve(cwd, sourcePath);
    const outputUnderSource = relative(protectedPath, outputRoot);
    const sourceUnderOutput = relative(outputRoot, protectedPath);
    const overlaps = (rel: string) => rel === "" || !isRelativePathEscape(rel);
    if (overlaps(outputUnderSource) || overlaps(sourceUnderOutput)) {
      throw new Error(`arena output root must not overlap protected source path ${sourcePath}`);
    }
  }
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", outputRelative], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    throw new Error("arena output root must be inside a repository-ignored result directory");
  }
}

function assertRunArtifactPaths(
  cwd: string,
  artifactDir: string,
  paths: readonly [string, string][],
): void {
  assertArenaOutputRoot(cwd, artifactDir);
  for (const [path, label] of paths) relativeInside(artifactDir, path, label);
  const byLabel = Object.fromEntries(paths.map(([path, label]) => [label, path]));
  const recordPath = byLabel["record path"]!;
  const cleanupPath = byLabel["cleanup path"]!;
  const workspace = byLabel["cell workspace"]!;
  if (recordPath === cleanupPath) throw new Error("record and cleanup paths must be distinct");
  for (const [path, label] of [[recordPath, "record"], [cleanupPath, "cleanup"]] as const) {
    const rel = relative(workspace, path);
    if (rel === "" || !isRelativePathEscape(rel)) {
      throw new Error(`${label} path must remain outside the harness-writable workspace`);
    }
  }
}

function assertRepositoryRoot(cwd: string): void {
  const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim());
  if (realpathSync(cwd) !== root) {
    throw new Error("arena cell cwd must be the source repository root");
  }
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWriteJson(root: string, path: string, value: unknown): void {
  assertSafeParentChain(root, path, "persisted artifact");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafeParentChain(root, path, "persisted artifact");
  if (lstatIfPresent(path)) throw new Error(`refusing to overwrite persisted artifact: ${path}`);
  const temporary = resolve(
    parent,
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.${basename(path)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, canonicalJson(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, path);
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    if (lstatIfPresent(parent)) fsyncDirectory(parent);
  }
}

function envTemplateNames(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      if (match[1]) out.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) envTemplateNames(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) envTemplateNames(entry, out);
  }
  return out;
}

function selectedEnvName(
  names: readonly (string | undefined)[],
  credentials: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return names.find((name) => name && credentials[name]?.trim()) ?? names.find(Boolean);
}

function topLevelAuthNames(pack: TargetPack): string[] {
  if (pack.auth?.type === "none") return [];
  return [pack.auth?.env || "ASANA_PAT", ...(pack.auth?.env_aliases ?? [])];
}

function connectionDataPlaneCli(pack: TargetPack, surface: SurfaceId): boolean {
  const auth = pack.surfaces?.cli?.auth;
  return surface === "cli"
    && Boolean(pack.sql_conn || pack.mongo_conn)
    && (!auth || auth.kind === "inherit");
}

/** Credential names are derived only from the immutable pack and selected
 * surface. Values remain out-of-band and runCell scopes the child to this list. */
export function cellCredentialNames(
  pack: TargetPack,
  surface: SurfaceId,
  harness: "codex" | "claude-code",
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    if (name) names.add(name);
  };
  add(harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  if (surface === "api" && pack.auth?.type !== "none") {
    add(selectedEnvName(topLevelAuthNames(pack), credentials));
  }
  for (const name of envTemplateNames(pack.base_url)) add(name);
  for (const scope of pack.sandbox_scope) {
    if (scope.required || credentials[scope.env]?.trim()) add(scope.env);
  }

  const surfaceAuth = surface === "api" ? undefined : pack.surfaces?.[surface]?.auth;
  if (surface === "cli" && pack.sql_conn?.connection_string_env) {
    add(pack.sql_conn.connection_string_env);
  }
  if (surface === "cli" && pack.mongo_conn?.connection_string_env) {
    add(pack.mongo_conn.connection_string_env);
  }
  if (surfaceAuth?.kind === "token") {
    add(selectedEnvName([surfaceAuth.token_env, ...(surfaceAuth.token_env_aliases ?? [])], credentials));
  } else if (surfaceAuth?.kind === "oauth_app") {
    add(surfaceAuth.client_id_env);
    add(surfaceAuth.client_secret_env);
    add(surfaceAuth.refresh_token_env);
  } else if (!connectionDataPlaneCli(pack, surface)) {
    add(selectedEnvName(topLevelAuthNames(pack), credentials));
  }

  return [...names].sort();
}

export function cellVerificationCredentialNames(
  pack: TargetPack,
  credentials: Readonly<Record<string, string | undefined>>,
  surface: SurfaceId = "api",
): string[] {
  const names = new Set<string>();
  const verifierAuthNames = pack.auth?.verify_env
    ? [pack.auth.verify_env, ...(pack.auth.verify_env_aliases ?? [])]
    : topLevelAuthNames(pack);
  const auth = selectedEnvName(verifierAuthNames, credentials);
  if (pack.auth?.type !== "none" && auth) names.add(auth);
  for (const name of envTemplateNames({
    base_url: pack.base_url,
    oracles: pack.tasks.flatMap((task) => task.oracles),
  })) names.add(name);
  for (const scope of pack.sandbox_scope) {
    if (scope.required || credentials[scope.env]?.trim()) names.add(scope.env);
  }
  if (pack.sql_conn?.connection_string_env) names.add(pack.sql_conn.connection_string_env);
  if (pack.mongo_conn?.connection_string_env) names.add(pack.mongo_conn.connection_string_env);
  return [...names].sort();
}

export function cellResetCredentialNames(
  pack: TargetPack,
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  const names = new Set<string>();
  if (pack.sql_conn?.connection_string_env) names.add(pack.sql_conn.connection_string_env);
  if (pack.mongo_conn?.connection_string_env) names.add(pack.mongo_conn.connection_string_env);
  if (pack.name === "turso") {
    const auth = selectedEnvName(
      [pack.auth?.env, ...(pack.auth?.env_aliases ?? [])],
      credentials,
    );
    if (auth) names.add(auth);
    for (const name of envTemplateNames(pack.base_url)) names.add(name);
  }
  if (pack.name === "convex") {
    for (const name of envTemplateNames(pack.base_url)) names.add(name);
    const management = selectedEnvName(
      ["CONVEX_TEAM_ACCESS_TOKEN", "CONVEX_MANAGEMENT_TOKEN"],
      credentials,
    );
    if (management && credentials[management]?.trim()) names.add(management);
  }
  return [...names];
}

function scopeValues(
  pack: TargetPack,
  credentials: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scope: Record<string, string> = {};
  for (const parameter of pack.sandbox_scope) {
    const raw = credentials[parameter.env]?.trim();
    if (!raw) {
      if (parameter.required) throw new Error(`Missing ${parameter.env} (sandbox ${parameter.name}).`);
      continue;
    }
    let value = raw;
    if (parameter.url_pattern) {
      try {
        value = raw.match(new RegExp(parameter.url_pattern))?.[1] ?? raw;
      } catch {
        value = raw;
      }
    }
    scope[parameter.name] = value;
  }
  return scope;
}

function cleanupFailure(
  cellId: string,
  recordPath: string,
  recordSha256: string,
  now: Date,
  message: string,
  namespace?: string,
  provider?: { id: string; version: string },
  secrets: readonly string[] = [],
  plan?: ResetPlan,
): ArenaCellCleanupRecord {
  const safe = safeCleanupText(message, secrets);
  return {
    schema: ARENA_CELL_CLEANUP_SCHEMA,
    cell_id: cellId,
    record_path: recordPath,
    record_sha256: recordSha256,
    generated_at: now.toISOString(),
    status: "unconfirmed",
    ...(provider ? { provider } : {}),
    ...(namespace ? { namespace } : {}),
    ...(plan ? {
      plan: {
        summary: safeCleanupText(plan.summary, secrets),
        resources: plan.resources.map((resource) => safeCleanupIdentifier(resource, secrets)),
      },
    } : {}),
    message: safe,
    errors: [safe],
  };
}

function safeCleanupText(value: string, secrets: readonly string[]): string {
  return redactCleanupText(value, secrets).slice(0, 4_096);
}

function redactCleanupText(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("<redacted>");
  }
  return redactSensitiveText(safe)
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://<redacted>@")
    .replace(/\b(?:bearer|token|password|secret)\s*[=:]\s*[^\s,;]+/gi, (match) => `${match.split(/[=:]/, 1)[0]}=<redacted>`);
}

function safeCleanupIdentifier(value: string, secrets: readonly string[]): string {
  const redacted = redactCleanupText(value, secrets);
  if (redacted === value && redacted.length <= 4_096) return redacted;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  const suffix = `#redacted-${digest}`;
  return `${redacted.slice(0, 4_096 - suffix.length)}${suffix}`;
}

function cleanupEvidenceContractErrors(
  planned: readonly string[],
  evidence: { supported: boolean; deleted: readonly string[]; errors: readonly string[] },
): string[] {
  const errors: string[] = [];
  if (new Set(planned).size !== planned.length) errors.push("cleanup plan contains duplicate resource identifiers");
  if (new Set(evidence.deleted).size !== evidence.deleted.length) errors.push("cleanup evidence contains duplicate resource identifiers");
  const expected = [...planned].sort();
  const actual = [...evidence.deleted].sort();
  if (expected.length !== actual.length || expected.some((resource, index) => resource !== actual[index])) {
    errors.push("cleanup evidence deleted set does not exactly match the immutable cleanup plan");
  }
  return errors;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function selectedCredentials(
  names: readonly string[],
  credentials: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(names.flatMap((name) => {
    const value = credentials[name]?.trim();
    return value ? [[name, value] as const] : [];
  })));
}

function normalizeCredentialSource(
  source: Readonly<Record<string, string | undefined>>,
): { credentials: Readonly<Record<string, string>>; secrets: readonly string[] } {
  const credentials: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const [name, raw] of Object.entries(structuredClone(source))) {
    if (typeof raw !== "string") continue;
    if (raw) secrets.add(raw);
    const trimmed = raw.trim();
    if (trimmed) {
      credentials[name] = trimmed;
      secrets.add(trimmed);
    }
  }
  return {
    credentials: deepFreeze(credentials),
    secrets: Object.freeze([...secrets]),
  };
}

function assertResetPlan(value: unknown): ResetPlan {
  if (!value || typeof value !== "object") throw new Error("reset provider returned an invalid cleanup plan");
  const plan = value as Partial<ResetPlan>;
  if (typeof plan.summary !== "string" || plan.summary.length > 4_096 || !Array.isArray(plan.resources)
    || plan.resources.some((resource) => typeof resource !== "string" || !resource.trim() || resource.length > 4_096)) {
    throw new Error("reset provider returned an invalid cleanup plan");
  }
  if (plan.resources.length > 100) throw new Error("cleanup plan exceeds the 100-resource safety limit");
  return { summary: plan.summary, resources: [...plan.resources] };
}

function assertResetEvidence(value: unknown): ResetEvidence {
  if (!value || typeof value !== "object") throw new Error("reset provider returned invalid cleanup evidence");
  const evidence = value as Partial<ResetEvidence>;
  if (typeof evidence.supported !== "boolean" || typeof evidence.message !== "string" || evidence.message.length > 4_096
    || !Array.isArray(evidence.deleted) || evidence.deleted.length > 100
    || evidence.deleted.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 4_096)
    || !Array.isArray(evidence.errors) || evidence.errors.length > 100
    || evidence.errors.some((entry) => typeof entry !== "string" || entry.length > 4_096)) {
    throw new Error("reset provider returned invalid cleanup evidence");
  }
  return {
    supported: evidence.supported,
    message: evidence.message,
    deleted: [...evidence.deleted],
    errors: [...evidence.errors],
  };
}

function cleanupProviderIdentity(provider: { id: string; version: string }): { id: string; version: string } {
  if (!/\S/.test(provider.id) || !/\S/.test(provider.version)
    || provider.id.length > 4_096 || provider.version.length > 4_096) {
    throw new Error("reset provider identity is invalid or exceeds cleanup evidence bounds");
  }
  return { id: provider.id, version: provider.version };
}

function cleanupTimestamp(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("controller clock returned an invalid cleanup timestamp");
  }
  return now;
}

interface DirectoryIdentity {
  realpath: string;
  dev: number;
  ino: number;
}

function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("cell artifact directory must be a regular non-symlink directory");
  }
  return { realpath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertRecordArtifacts(
  record: NormalizedCellRecord,
  expectedArtifactDir: string,
  expectedIdentity: DirectoryIdentity,
): void {
  const currentIdentity = directoryIdentity(expectedArtifactDir);
  if (currentIdentity.realpath !== expectedIdentity.realpath
    || currentIdentity.dev !== expectedIdentity.dev
    || currentIdentity.ino !== expectedIdentity.ino) {
    throw new Error("cell artifact directory identity changed during execution");
  }
  const expected = currentIdentity.realpath;
  const reportedRoot = lstatSync(record.artifacts.base_dir);
  if (reportedRoot.isSymbolicLink() || !reportedRoot.isDirectory()) {
    throw new Error("runCell artifact base must be a regular non-symlink directory");
  }
  const actual = realpathSync(record.artifacts.base_dir);
  if (actual !== expected) throw new Error("runCell returned an artifact base outside the isolated cell workspace");
  const rootStat = lstatSync(expected);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("runCell artifact base must remain a real directory");
  }
  for (const [label, path] of Object.entries(record.artifacts).filter(([name]) => name !== "base_dir")) {
    if (isAbsolute(path) || basename(path) !== path) {
      throw new Error(`record artifact ${label} must be a direct relative filename`);
    }
    const absolute = resolve(expected, path);
    relativeInside(expected, absolute, `record artifact ${label}`);
    const stat = lstatIfPresent(absolute);
    if (record.status === "completed" && !stat) {
      throw new Error(`completed record artifact ${label} is missing`);
    }
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new Error(`record artifact ${label} must be a regular non-symlink file`);
    }
  }
}

export function assertArenaRecordIdentity(record: NormalizedCellRecord, cell: EvaluationCell): void {
  const mismatches = [
    ["cell_id", record.cell_id, cell.cell_id],
    ["record_id", record.record_id, cell.cell_id],
    ["batch_id", record.batch_id, cell.batch_id],
    ["run_batch_id", record.run_batch_id, cell.batch_id],
    ["evaluation_set_id", record.evaluation_set_id, cell.evaluation_set_id],
    ["evaluation_set_version", record.evaluation_set_version, cell.evaluation_set_version],
    ["standard_set_version", record.standard_set_version, cell.evaluation_set_version],
    ["pack_content_hash", record.pack_content_hash, cell.pack.content_hash],
    ["source_commit_sha", record.source_commit_sha, cell.source_commit_sha],
    ["target_id", record.target_id, cell.target_id],
    ["product", record.product, cell.target_id],
    ["surface", record.surface, cell.surface],
    ["harness", record.harness, cell.harness.id],
    ["trial", record.trial, cell.trial],
    ["effort", record.effort, cell.harness.effort],
    ["requested_model", record.requested_model, cell.harness.model],
    ["profiles", JSON.stringify(record.profiles), JSON.stringify([cell.harness.profile])],
  ].filter(([, actual, expected]) => actual !== expected)
    .map(([field]) => field);
  if (mismatches.length) {
    throw new Error(`runCell returned a record outside the immutable cell identity: ${mismatches.join(", ")}`);
  }
  if (record.best_profile !== null && record.best_profile !== cell.harness.profile) {
    throw new Error("runCell returned a best_profile outside the immutable cell identity");
  }
  if (record.status === "completed" && record.best_profile !== cell.harness.profile) {
    throw new Error("completed runCell record must bind best_profile to the requested profile");
  }
  if (record.status !== "blocked" && !record.execution_namespace) {
    throw new Error("post-invocation runCell record must include the runtime execution namespace");
  }
  if (record.status === "blocked" && record.execution_namespace) {
    throw new Error("pre-invocation blocked record must not contain an execution namespace");
  }
  if (record.execution_namespace
    && (!/^[a-z0-9-]+$/.test(record.execution_namespace)
      || Buffer.byteLength(record.execution_namespace) > 43)) {
    throw new Error("runCell returned an invalid or unbounded execution namespace");
  }
}

function assertRecordMatchesCell(
  record: NormalizedCellRecord,
  cell: EvaluationCell,
  secrets: readonly string[],
): void {
  if (containsCredentialMaterial(record, secrets)) {
    throw new Error("runCell returned a normalized record containing credential material");
  }
  assertArenaRecordIdentity(record, cell);
}

function containsCredentialMaterial(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => value.includes(secret));
  if (Array.isArray(value)) return value.some((entry) => containsCredentialMaterial(entry, secrets));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
      secrets.some((secret) => key.includes(secret)) || containsCredentialMaterial(entry, secrets));
  }
  return false;
}

function committedBlob(root: string, sourceCommitSha: string, path: string): Buffer {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const rel = relative(realRoot, realPath);
  if (!rel || isRelativePathEscape(rel)) {
    throw new Error("canonical benchmark input must live inside the source repository");
  }
  return execFileSync("git", ["show", `${sourceCommitSha}:${rel.replaceAll("\\", "/")}`], {
    cwd: realRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertCommittedInputs(
  cwd: string,
  sourceCommitSha: string,
  packPath: string,
  pack: TargetPack,
): void {
  const head = resolveSourceCommitSha(cwd);
  if (head !== sourceCommitSha) {
    throw new Error(`cell source commit ${sourceCommitSha} does not match checked-out HEAD ${head}`);
  }
  const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim());
  const sidecarPath = approvalPath(packPath);
  assertRegularFile(packPath, "canonical pack");
  assertRegularFile(sidecarPath, "canonical approval");
  const packHash = packFileContentHash(packPath);
  const exactApproval = checkCellApproval(pack, packPath, packHash);
  if (!exactApproval.ok) {
    const legacyApproval = checkCommittedLegacyCellApproval(pack, packPath, packHash, {
      repositoryRoot: root,
      sourceCommitSha,
      sourcePackPath: packPath,
    });
    if (!legacyApproval.ok) {
      throw new Error(`canonical pack approval is invalid: ${exactApproval.reason}; ${legacyApproval.reason}`);
    }
  }
  for (const path of [packPath, sidecarPath]) {
    const current = readFileSync(path);
    const committed = committedBlob(root, sourceCommitSha, path);
    if (current.length !== committed.length || !current.equals(committed)) {
      throw new Error(`${relative(root, realpathSync(path))} bytes do not match source commit ${sourceCommitSha}`);
    }
  }
}

function assertIsolatedInputCopies(
  cwd: string,
  sourceCommitSha: string,
  sourcePackPath: string,
  runtimePackPath: string,
): void {
  const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim());
  for (const [runtimePath, sourcePath] of [
    [runtimePackPath, sourcePackPath],
    [approvalPath(runtimePackPath), approvalPath(sourcePackPath)],
  ] as const) {
    assertRegularFile(runtimePath, "isolated benchmark input");
    const runtime = readFileSync(runtimePath);
    const committed = committedBlob(root, sourceCommitSha, sourcePath);
    if (runtime.length !== committed.length || !runtime.equals(committed)) {
      throw new Error("isolated benchmark input bytes do not match the source commit");
    }
  }
}

export function resolveSourceCommitSha(cwd: string): string {
  const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim());
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("could not resolve an immutable source commit SHA");
  const objectType = execFileSync("git", ["cat-file", "-t", sha], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (objectType !== "commit") throw new Error("resolved source SHA is not a commit object");
  const dirty = execFileSync("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...SOURCE_PATHS,
  ], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (dirty.length > 0) {
    throw new Error("arena execution requires a clean source tree so code, package metadata, and benchmark artifacts match the recorded source commit SHA");
  }
  return sha;
}

/** One cell lifecycle: fresh registry, in-process runCell, durable record, then
 * provider selection/plan/execute and durable cleanup evidence. */
export async function executeArenaCell(
  spec: ArenaCellSpec,
  dependencies: ArenaCellDependencies,
): Promise<ArenaCellExecution> {
  if (!dependencies.execution) throw new Error("arena cell execution requires an explicit runtime backend and trust level");
  const execution = ArenaExecutionModeSchema.parse(dependencies.execution);
  if (dependencies.runCell) {
    throw new Error("arena execution owns the ax-eval runCell implementation");
  }
  if (execution.runtime_backend === "native") {
    if (dependencies.sandbox) throw new Error("native execution cannot claim a pinned OCI sandbox");
    return executeArenaCellInternal(spec, {
      ...dependencies,
      runCell,
    }, true);
  }
  if (!dependencies.sandbox) throw new Error("pinned-oci execution requires the reviewed OCI sandbox");
  const sandbox = createBubblewrapSandbox(dependencies.sandbox);
  return executeArenaCellInternal(spec, {
    ...dependencies,
    runCell: (cell, options) => runCell(cell, { ...options, sandbox }),
  }, true);
}

/** Offline contract-test seam. Deliberately excluded from the package entrypoint. */
export async function executeArenaCellWithInjectedRuntime(
  spec: ArenaCellSpec,
  dependencies: ArenaCellDependencies,
): Promise<ArenaCellExecution> {
  return executeArenaCellInternal(spec, dependencies, false);
}

async function executeArenaCellInternal(
  spec: ArenaCellSpec,
  dependencies: ArenaCellDependencies,
  trustedSandbox: boolean,
): Promise<ArenaCellExecution> {
  const cwd = resolve(spec.cwd);
  const packPath = resolve(spec.packPath);
  const recordPath = resolve(spec.recordPath);
  const cleanupPath = resolve(spec.cleanupPath);
  const artifactDir = resolve(spec.artifactDir);
  const workspace = resolve(artifactDir, "workspace");
  const { credentials, secrets: credentialSecrets } = normalizeCredentialSource(dependencies.credentials);
  if (spec.harness === "claude-code" && !trustedSandbox) {
    throw new Error("claude-code arena cells require the trusted workflow filesystem sandbox, which is not available in this slice");
  }
  relativeInside(cwd, packPath, "canonical pack path");
  assertRunArtifactPaths(cwd, artifactDir, [
    [recordPath, "record path"],
    [cleanupPath, "cleanup path"],
    [workspace, "cell workspace"],
  ]);
  for (const [path, label] of [
    [packPath, "canonical pack path"],
    [recordPath, "record path"],
    [cleanupPath, "cleanup path"],
    [workspace, "cell workspace"],
  ] as const) {
    assertSafeParentChain(cwd, path, label);
  }
  const existing = [recordPath, cleanupPath, workspace].filter((path) => lstatIfPresent(path));
  if (existing.length) {
    throw new Error(
      `refusing to overwrite existing immutable cell artifact(s): ${existing.join(", ")}; choose a new run directory`,
    );
  }
  assertRegularFile(packPath, "canonical pack");
  assertRegularFile(approvalPath(packPath), "canonical approval");
  const pack = deepFreeze(structuredClone(loadPack(packPath)));
  assertCommittedInputs(cwd, spec.sourceCommitSha, packPath, pack);
  const inputDir = resolve(workspace, "input");
  const runtimeArtifactDir = resolve(workspace, "artifacts");
  const runtimePackPath = resolve(inputDir, "pack.yaml");
  mkdirSync(inputDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeArtifactDir, { recursive: true, mode: 0o700 });
  const runtimeArtifactIdentity = directoryIdentity(runtimeArtifactDir);
  assertSafeParentChain(cwd, runtimePackPath, "isolated pack");
  copyFileSync(packPath, runtimePackPath, constants.COPYFILE_EXCL);
  copyFileSync(approvalPath(packPath), approvalPath(runtimePackPath), constants.COPYFILE_EXCL);
  assertRegularFile(runtimePackPath, "isolated pack");
  assertRegularFile(approvalPath(runtimePackPath), "isolated approval");
  assertIsolatedInputCopies(cwd, spec.sourceCommitSha, packPath, runtimePackPath);
  const packContentHash = packFileContentHash(runtimePackPath);
  const cellId = arenaCellId(spec, packContentHash);
  const hostCredentialNames = cellCredentialNames(pack, spec.surface, spec.harness, credentials);
  const verificationCredentialNames = cellVerificationCredentialNames(pack, credentials, spec.surface);
  const resetCredentialNames = cellResetCredentialNames(pack, credentials);
  const cell = deepFreeze(EvaluationCellSchema.parse({
    schema: "ax.evaluation-cell/v1",
    cell_id: cellId,
    batch_id: spec.batchId,
    evaluation_set_id: spec.evaluationSetId,
    evaluation_set_version: pack.standard_set_version,
    target_id: spec.targetId,
    pack: {
      path: relativeInside(workspace, runtimePackPath, "pack path"),
      content_hash: packContentHash,
    },
    surface: spec.surface,
    harness: {
      id: spec.harness,
      profile: spec.profile,
      model: spec.model,
      effort: spec.effort,
    },
    trial: spec.trial,
    source_commit_sha: spec.sourceCommitSha,
    required_credentials: hostCredentialNames,
    run_context: {
      cwd: workspace,
      artifact_dir: relativeInside(workspace, runtimeArtifactDir, "artifact directory"),
      invoke_timeout_ms: spec.invokeTimeoutMs,
      first_action_timeout_ms: spec.firstActionTimeoutMs,
      invoke_retries: spec.invokeRetries,
    },
  }));
  const registry = await dependencies.createRegistry(cell, pack);
  const hostCredentials = selectedCredentials(cell.required_credentials, credentials);
  const verifierCredentials = selectedCredentials(
    verificationCredentialNames,
    credentials,
  );
  if (!dependencies.runCell) throw new Error("arena cell execution requires a runCell implementation");
  const returnedRecord = await dependencies.runCell(cell, {
    credentials: hostCredentials,
    verificationCredentials: verifierCredentials,
    extensions: { registry },
    approval: {
      allowCommittedLegacy: true,
      sourceRepositoryRoot: cwd,
      sourcePackPath: packPath,
    },
  });
  const parsedRecord = NormalizedCellRecordSchema.safeParse(returnedRecord);
  if (!parsedRecord.success) {
    throw new Error("runCell returned an invalid normalized record");
  }
  const record = parsedRecord.data;
  assertRecordMatchesCell(record, cell, credentialSecrets);
  assertRecordArtifacts(record, runtimeArtifactDir, runtimeArtifactIdentity);
  const recordSha256 = createHash("sha256").update(canonicalJson(record)).digest("hex");
  atomicWriteJson(cwd, recordPath, record);

  let postRunIntegrityError: string | undefined;
  try {
    assertCommittedInputs(cwd, spec.sourceCommitSha, packPath, pack);
  } catch (error) {
    postRunIntegrityError = error instanceof Error ? error.message : String(error);
  }
  assertSafeParentChain(cwd, cleanupPath, "cleanup path");
  if (lstatIfPresent(cleanupPath)) {
    throw new Error("cleanup evidence path changed during cell execution; cleanup was not executed");
  }
  const cleanupNow = cleanupTimestamp(dependencies.now());

  const namespace = record.execution_namespace;
  const resetCredentials = selectedCredentials(resetCredentialNames, credentials);
  const secretValues = credentialSecrets;
  let cleanup: ArenaCellCleanupRecord;
  if (spec.skipReset) {
    cleanup = {
      schema: ARENA_CELL_CLEANUP_SCHEMA,
      cell_id: cell.cell_id,
      record_path: recordPath,
      record_sha256: recordSha256,
      generated_at: cleanupNow.toISOString(),
      status: "skipped",
      ...(namespace ? { namespace } : {}),
      message: "skip-reset requested",
      errors: [],
    };
  } else if (!namespace) {
    cleanup = cleanupFailure(
      cell.cell_id,
      recordPath,
      recordSha256,
      cleanupNow,
      "no persisted executor namespace is available for bounded cleanup",
      undefined,
      undefined,
      secretValues,
    );
  } else {
    let resetProvider;
    let providerIdentity: { id: string; version: string } | undefined;
    try {
      const candidate = resolveRuntimeExtensions(registry, { cell, pack })
        .resetProviders.providerFor({ cell, pack });
      if (candidate) providerIdentity = cleanupProviderIdentity(candidate);
      resetProvider = candidate;
    } catch (error) {
      cleanup = cleanupFailure(
        cell.cell_id,
        recordPath,
        recordSha256,
        cleanupNow,
        `reset provider selection failed: ${error instanceof Error ? error.message : String(error)}`,
        namespace,
        undefined,
        secretValues,
      );
    }
    if (!resetProvider) {
      cleanup ??= cleanupFailure(
          cell.cell_id,
          recordPath,
          recordSha256,
          cleanupNow,
          "no reset provider is registered for this target",
          namespace,
          undefined,
          secretValues,
        );
    } else {
      const provider = providerIdentity!;
      let planSnapshot: ResetPlan | undefined;
      try {
        const scope = scopeValues(pack, credentials);
        const context = deepFreeze(structuredClone({
          cell,
          pack,
          credentials: resetCredentials,
          scope,
          namespace,
          dryRun: false,
        }));
        planSnapshot = deepFreeze(structuredClone(assertResetPlan(await resetProvider.plan(context))));
        if (new Set(planSnapshot.resources).size !== planSnapshot.resources.length) {
          throw new Error("cleanup plan contains duplicate resource identifiers");
        }
        const serializedPlan = JSON.stringify(planSnapshot);
        const evidence = assertResetEvidence(await resetProvider.execute(planSnapshot, context));
        const contractErrors = cleanupEvidenceContractErrors(planSnapshot.resources, evidence);
        if (JSON.stringify(planSnapshot) !== serializedPlan) {
          contractErrors.push("cleanup provider mutated the immutable cleanup plan");
        }
        const safePlan = {
          summary: safeCleanupText(planSnapshot.summary, secretValues),
          resources: planSnapshot.resources.map((resource) => safeCleanupIdentifier(resource, secretValues)),
        };
        const safeDeleted = evidence.deleted.map((resource) => safeCleanupIdentifier(resource, secretValues));
        const safeContractErrors = cleanupEvidenceContractErrors(safePlan.resources, {
          ...evidence,
          deleted: safeDeleted,
        });
        const safeEvidence = {
          supported: evidence.supported,
          message: safeCleanupText(evidence.message, secretValues),
          deleted: safeDeleted,
          errors: [...evidence.errors, ...contractErrors, ...safeContractErrors]
            .map((error) => safeCleanupText(error, secretValues)),
        };
        const confirmed = safeEvidence.supported && safeEvidence.errors.length === 0;
        cleanup = {
          schema: ARENA_CELL_CLEANUP_SCHEMA,
          cell_id: cell.cell_id,
          record_path: recordPath,
          record_sha256: recordSha256,
          generated_at: cleanupNow.toISOString(),
          status: confirmed ? "confirmed" : "unconfirmed",
          provider,
          namespace,
          plan: safePlan,
          evidence: safeEvidence,
          message: safeEvidence.message,
          errors: [...safeEvidence.errors],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanup = cleanupFailure(
          cell.cell_id,
          recordPath,
          recordSha256,
          cleanupNow,
          `cleanup failed: ${message}`,
          namespace,
          provider,
          secretValues,
          planSnapshot,
        );
      }
    }
  }
  if (postRunIntegrityError) {
    const message = safeCleanupText(
      `source integrity changed during cell execution: ${postRunIntegrityError}`,
      secretValues,
    );
    cleanup = {
      ...cleanup,
      status: "unconfirmed",
      message,
      errors: [message, ...cleanup.errors].slice(0, 128),
    };
  }
  cleanup = ArenaCellCleanupSchema.parse(cleanup);
  atomicWriteJson(cwd, cleanupPath, cleanup);
  if (postRunIntegrityError) {
    throw new Error(cleanup.message);
  }
  return {
    cell,
    pack,
    credentialNames: {
      host: [...hostCredentialNames],
      verification: [...verificationCredentialNames],
      reset: [...resetCredentialNames],
    },
    record,
    recordPath,
    cleanup,
    cleanupPath,
  };
}
