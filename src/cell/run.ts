import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { loadPack } from "../config.js";
import { scoreDiscovery } from "../generate/discovery.js";
import { buildBlockedResult, buildNormalizedResult } from "../generate/record.js";
import {
  checkCellApproval,
  checkCommittedLegacyCellApproval,
  packFileContentHash,
} from "../generate/review.js";
import { buildVerificationClientOptions } from "../generate/verification-client.js";
import {
  type OracleProviderRegistry,
} from "../generate/oracle-provider.js";
import {
  loadResults,
  loadRequiredTrace,
  verifyGeneratedPack,
  type ExecutorResults,
  type RoundtripOutcome,
} from "../generate/verify.js";
import type { ProfileRun } from "../generate/report.js";
import {
  defaultInvokePaths,
  detectInvokeHarness,
  detectInvokeHarnessSandboxed,
  redactHarnessArtifactText,
  runInvokeHarness,
  type InvokeDetection,
  type InvokeRunOptions,
  type InvokeRunResult,
} from "../harness/invoke.js";
import type { ChildProcessSandbox } from "../harness/child-sandbox.js";
import { buildExecutorPrompt, type TraceStep } from "../harness/executor.js";
import { getProfile } from "../harness/profile.js";
import {
  observedToDiscovery,
  observedToTrace,
  parseTranscript,
  type ObservedRun,
} from "../harness/transcript.js";
import {
  provisionHarnessForSurface,
  type HarnessProvisioning,
} from "../harness/mcp-provision.js";
import { BearerClient } from "../http/client.js";
import { redactSensitiveText } from "../safety/redaction.js";
import {
  createRuntimeExtensionRegistry,
  resolveRuntimeExtensions,
  type HealthCheckProvider,
  type ProviderReference,
  type ProvisioningEvidence,
  type ProvisioningProvider,
  type RuntimeExtensionKind,
  type RuntimeExtensionRegistry,
  type TargetAdapter,
} from "../runtime/extensions.js";
import { getSurface, resolveSurfaceSelection, tasksForSurface } from "../surface/index.js";
import {
  describeRequiredEnv,
  resolveEnvTemplate,
  surfaceAuthStatus,
  type EnvSource,
} from "../target/config.js";
import type { TargetPack } from "../schemas.js";
import {
  EvaluationCellSchema,
  NORMALIZED_CELL_RECORD_SCHEMA,
  NormalizedCellRecordSchema,
  type EvaluationCell,
  type NormalizedCellRecord,
} from "./schema.js";

export type CredentialSource = EnvSource;

export interface RunCellOptions {
  /** Values are supplied out-of-band and are never serialized into the cell or record. */
  credentials: CredentialSource;
  /** Controller-only values for verification, health checks, and dynamic
   * read-back transports. These are never copied into the harness child env. */
  verificationCredentials?: CredentialSource;
  extensions?: {
    /** Immutable, per-cell registry. Arena/controller code should use this path. */
    registry?: RuntimeExtensionRegistry;
    /** @deprecated Compatibility for callers predating the combined registry. */
    oracleProviders?: OracleProviderRegistry;
  };
  approval?: {
    /** One-release arena compatibility for approvals whose exact pack and
     * sidecar bytes are committed at the cell's immutable source SHA. */
    allowCommittedLegacy?: boolean;
    sourceRepositoryRoot?: string;
    sourcePackPath?: string;
  };
  signal?: AbortSignal;
  /** Trusted controllers use this for the harness process and version probe. */
  sandbox?: ChildProcessSandbox;
}

export interface CellRuntimeDependencies {
  now(): Date;
  detectHarness(
    id: EvaluationCell["harness"]["id"],
    env?: Record<string, string>,
    sandbox?: ChildProcessSandbox,
    cwd?: string,
  ): InvokeDetection;
  provisionHarness(opts: Parameters<typeof provisionHarnessForSurface>[0]): Promise<HarnessProvisioning>;
  invokeHarness(opts: InvokeRunOptions): Promise<InvokeRunResult>;
  verificationClient(pack: TargetPack, executor: ExecutorResults, credentials: CredentialSource): BearerClient;
  verify(
    pack: TargetPack,
    executor: ExecutorResults,
    client: BearerClient,
    cell: EvaluationCell,
    observed: ObservedRun | undefined,
    trace: readonly TraceStep[],
    oracleProviders: OracleProviderRegistry,
    credentials: CredentialSource,
  ): Promise<RoundtripOutcome[]>;
}

const DEFAULT_RUNTIME: CellRuntimeDependencies = {
  now: () => new Date(),
  detectHarness: (id, env, sandbox, cwd) => sandbox && cwd
    ? detectInvokeHarnessSandboxed(id, sandbox, cwd, env)
    : detectInvokeHarness(id, undefined, env, false),
  provisionHarness: provisionHarnessForSurface,
  invokeHarness: runInvokeHarness,
  verificationClient: (pack, executor, credentials) =>
    new BearerClient(buildVerificationClientOptions(pack, executor, credentials)),
  verify: (pack, executor, client, cell, observed, trace, oracleProviders, credentials) =>
    verifyGeneratedPack(pack, executor, client, cell.surface, observed, {
      oracleProviders,
      env: credentials,
      credentials,
      trace,
    }),
};

const SAFE_PARENT_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CI",
] as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function scopedCredentials(cell: EvaluationCell, source: CredentialSource): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of cell.required_credentials) {
    const value = source[name]?.trim();
    if (value) values[name] = value;
  }
  return values;
}

function normalizedCredentials(source: CredentialSource): Record<string, string> {
  return Object.fromEntries(Object.entries(source).flatMap(([name, value]) => {
    const normalized = value?.trim();
    return normalized ? [[name, normalized] as const] : [];
  }));
}

function verifierOnlyCredentialNames(pack: TargetPack): Set<string> {
  // A distinct verification credential is deliberately kept out of the host
  // agent process. It remains available to the independent read-back client.
  return new Set([
    pack.auth?.verify_env,
    ...(pack.auth?.verify_env_aliases ?? []),
  ].filter((name): name is string => Boolean(name)));
}

function harnessCredentials(pack: TargetPack, credentials: Record<string, string>): Record<string, string> {
  const verifierOnly = verifierOnlyCredentialNames(pack);
  return Object.fromEntries(Object.entries(credentials).filter(([name]) => !verifierOnly.has(name)));
}

function childEnvironment(pack: TargetPack, credentials: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_PARENT_ENV) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  Object.assign(out, harnessCredentials(pack, credentials));
  return out;
}

type CellProviderReference = Omit<ProviderReference, "kind"> & {
  kind: Exclude<RuntimeExtensionKind, "reset">;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function selectedProviderProvenance(
  cell: EvaluationCell,
  pack: TargetPack,
  oracleProviders: OracleProviderRegistry,
  provisioningProvider: ProvisioningProvider | undefined,
  healthCheckProvider: { id: string; version: string } | undefined,
  targetAdapter: { id: string; version: string } | undefined,
): CellProviderReference[] {
  const references: CellProviderReference[] = [];
  if (targetAdapter) references.push({ kind: "target-adapter", id: targetAdapter.id, version: targetAdapter.version });
  if (provisioningProvider) references.push({ kind: "provisioning", id: provisioningProvider.id, version: provisioningProvider.version });
  if (healthCheckProvider) references.push({ kind: "health-check", id: healthCheckProvider.id, version: healthCheckProvider.version });
  for (const task of tasksForSurface(pack, cell.surface)) {
    for (const oracle of task.oracles) {
      try {
        const provider = oracleProviders.providerFor(oracle);
        if (provider) references.push({ kind: "oracle", id: provider.id, version: provider.version });
      } catch {
        // Verification contains matcher failures per oracle. Provenance must
        // never promote one broken matcher into a cell-wide preflight block.
      }
    }
  }
  const unique = new Map(references.map((entry) => [`${entry.kind}\0${entry.id}\0${entry.version}`, entry]));
  return [...unique.values()].sort((a, b) =>
    compareText(a.kind, b.kind) || compareText(a.id, b.id) || compareText(a.version, b.version));
}

function recordProvenance(providers: readonly CellProviderReference[]): object {
  return providers.length ? { provider_provenance: providers } : {};
}

function mergeExtensionProvisioning(
  core: HarnessProvisioning,
  extension: ProvisioningEvidence | undefined,
  provider: ProvisioningProvider | undefined,
  baseEnv: Readonly<Record<string, string>>,
  reservedCredentials: Readonly<Record<string, string>>,
  cwd: string,
  artifactDir: string,
): HarnessProvisioning {
  if (!extension || !provider) return core;
  const additions = { ...(extension.env ?? {}) };
  for (const [name, value] of Object.entries(additions)) {
    if (typeof value !== "string") {
      throw new Error(`provisioning provider "${provider.id}" returned a non-string value for ${name}`);
    }
  }
  const reservedEnvironment = new Set<string>([...SAFE_PARENT_ENV, "CODEX_HOME"]);
  const collisions = Object.keys(additions).filter((name) =>
    reservedEnvironment.has(name) || name in reservedCredentials || name in baseEnv || name in core.env);
  if (collisions.length) {
    throw new Error(`provisioning provider "${provider.id}" attempted to replace environment key(s): ${collisions.join(", ")}`);
  }
  const pathEntries: string[] = [];
  for (const entry of extension.pathEntries ?? []) {
    if (typeof entry !== "string" || !entry.trim() || !isAbsolute(entry)) {
      throw new Error(`provisioning provider "${provider.id}" returned an invalid PATH entry`);
    }
    const canonical = realpathSync(entry);
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`provisioning provider "${provider.id}" PATH entry must be a real directory`);
    }
    for (const [root, label] of [[cwd, "cell workspace"], [artifactDir, "artifact directory"]] as const) {
      const rel = relative(realpathSync(root), canonical);
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))) {
        throw new Error(`provisioning provider "${provider.id}" PATH entry must resolve outside the writable ${label}`);
      }
    }
    if (!pathEntries.includes(canonical)) pathEntries.push(canonical);
  }
  const inheritedPath = core.env.PATH ?? baseEnv.PATH ?? "";
  const env = {
    ...core.env,
    ...additions,
    ...(pathEntries.length
      ? { PATH: [...pathEntries, inheritedPath].filter(Boolean).join(delimiter) }
      : {}),
  };
  if (extension.metadata) {
    try {
      JSON.stringify(extension.metadata);
    } catch {
      throw new Error(`provisioning provider "${provider.id}" returned non-serializable metadata`);
    }
  }
  return {
    env,
    meta: {
      ...(core.meta ?? {}),
      extension_provider: { id: provider.id, version: provider.version },
      ...(extension.metadata ? { extension_metadata: extension.metadata } : {}),
    },
  };
}

function detectionEnvironment(artifactDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SAFE_PARENT_ENV) {
    if (name === "HOME") continue;
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const home = resolve(artifactDir, ".invoke-home", "harness-detection");
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  return env;
}

function ensureInvokeHomeRoot(cwd: string, artifactDir: string): void {
  const homeRoot = resolve(artifactDir, ".invoke-home");
  if (existsSync(homeRoot)) {
    const stat = lstatSync(homeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("artifact .invoke-home must be a real directory inside run_context.cwd");
    }
  } else {
    mkdirSync(homeRoot, { recursive: true });
  }
  const rel = relative(realpathSync(cwd), realpathSync(homeRoot));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("artifact .invoke-home must resolve inside run_context.cwd");
  }
}

function artifactNames(paths: ReturnType<typeof defaultInvokePaths>): NormalizedCellRecord["artifacts"] {
  return {
    base_dir: dirname(paths.resultsPath),
    results: basename(paths.resultsPath),
    trace: basename(paths.tracePath),
    transcript: basename(paths.transcriptPath),
    invoke_metadata: basename(paths.metaPath),
  };
}

function safeMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("<redacted>");
  }
  return redactSensitiveText(message);
}

function terminalRecord(args: {
  cell: EvaluationCell;
  pack: TargetPack;
  paths: ReturnType<typeof defaultInvokePaths>;
  startedAt: string;
  completedAt: string;
  blocked: "requires-oauth" | "missing-credential" | "missing-harness" | "health-check-failed" | "invoke-failed";
  stage: "preflight" | "provision" | "invoke" | "verify";
  message: string;
  status?: "failed" | "blocked";
  executionNamespace?: string;
  providerProvenance?: readonly CellProviderReference[];
}): NormalizedCellRecord {
  const base = buildBlockedResult(
    args.pack,
    args.cell.surface,
    args.cell.harness.id,
    args.blocked === "health-check-failed" ? "invoke-failed" : args.blocked,
  );
  const record = {
    ...base,
    schema: NORMALIZED_CELL_RECORD_SCHEMA,
    generated_at: args.completedAt,
    model: args.cell.harness.model,
    run_batch_id: args.cell.batch_id,
    profiles: [args.cell.harness.profile],
    record_id: args.cell.cell_id,
    cell_id: args.cell.cell_id,
    batch_id: args.cell.batch_id,
    evaluation_set_id: args.cell.evaluation_set_id,
    evaluation_set_version: args.cell.evaluation_set_version,
    pack_content_hash: args.cell.pack.content_hash,
    source_commit_sha: args.cell.source_commit_sha,
    ...(args.executionNamespace ? { execution_namespace: args.executionNamespace } : {}),
    target_id: args.cell.target_id,
    trial: args.cell.trial,
    effort: args.cell.harness.effort,
    requested_model: args.cell.harness.model,
    started_at: args.startedAt,
    completed_at: args.completedAt,
    status: args.status ?? "blocked",
    blocked: args.blocked,
    error: { stage: args.stage, message: args.message },
    ...recordProvenance(args.providerProvenance ?? []),
    task_results: [],
    artifacts: artifactNames(args.paths),
  };
  return NormalizedCellRecordSchema.parse(record);
}

function assertCellMatchesPack(
  cell: EvaluationCell,
  pack: TargetPack,
  packPath: string,
  cwd: string,
  options: RunCellOptions,
): void {
  const targetId = pack.name.replace(/-generated$/, "");
  if (cell.target_id !== targetId) {
    throw new Error(`cell target_id ${cell.target_id} does not match reviewed pack target ${targetId}`);
  }
  if (cell.evaluation_set_version !== pack.standard_set_version) {
    throw new Error(
      `cell evaluation_set_version ${cell.evaluation_set_version} does not match pack standard_set_version ${pack.standard_set_version}`,
    );
  }
  const actualHash = packFileContentHash(packPath);
  if (cell.pack.content_hash !== actualHash) {
    throw new Error(`reviewed pack content hash mismatch (cell ${cell.pack.content_hash}, actual ${actualHash})`);
  }
  let approval = checkCellApproval(pack, packPath, cell.pack.content_hash);
  if (!approval.ok && options.approval?.allowCommittedLegacy) {
    approval = checkCommittedLegacyCellApproval(pack, packPath, cell.pack.content_hash, {
      repositoryRoot: options.approval.sourceRepositoryRoot ?? cwd,
      sourceCommitSha: cell.source_commit_sha,
      ...(options.approval.sourcePackPath ? { sourcePackPath: options.approval.sourcePackPath } : {}),
    });
  }
  if (!approval.ok) throw new Error(`reviewed pack approval is invalid: ${approval.reason}`);
  resolveSurfaceSelection(pack, cell.surface);
  getProfile(cell.harness.profile);
}

function resolveWithin(cwd: string, candidate: string, label: string): string {
  const realCwd = realpathSync(cwd);
  const lexicalPath = resolve(realCwd, candidate);
  let existing = lexicalPath;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  const path = resolve(realExisting, relative(existing, lexicalPath));
  const rel = relative(realCwd, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside run_context.cwd`);
  }
  return path;
}

function stableSlug(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${slug}-${digest}`;
}

/** Keep live resource identifiers below PostgreSQL's 63-byte identifier limit.
 * The digest binds the full immutable cell identity while the short prefix
 * remains recognizable in sandbox inventories. */
function executionNamespace(pack: TargetPack, cell: EvaluationCell): string {
  const prefix = (pack.run_id || pack.name || "cell")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12) || "cell";
  const harness = cell.harness.id === "codex" ? "cdx" : "cld";
  const digest = createHash("sha256")
    .update(JSON.stringify([
      cell.batch_id,
      cell.cell_id,
      cell.evaluation_set_id,
      cell.evaluation_set_version,
      cell.target_id,
      cell.pack.content_hash,
      cell.surface,
      cell.harness.id,
      cell.harness.profile,
      cell.harness.model,
      cell.harness.effort,
      String(cell.trial),
      cell.source_commit_sha,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${harness}-${cell.harness.effort[0]}-${digest}`;
}

function failedOutcomes(pack: TargetPack, cell: EvaluationCell, message: string): RoundtripOutcome[] {
  return tasksForSurface(pack, cell.surface).map((task) => ({
    taskId: task.id,
    difficulty: task.difficulty,
    profile: cell.harness.profile,
    success: false,
    oracleResults: [],
    error: message,
    na: task.oracles.length > 0 && task.oracles.every((oracle) => oracle.type === "na"),
  }));
}

function providerOwnsConnectionRole(
  tasks: readonly TargetPack["tasks"][number][],
  providers: OracleProviderRegistry,
  role: "sql_conn" | "mongo_conn",
): boolean {
  const relevant = tasks.flatMap((task) => task.oracles).filter((oracle) =>
    role === "sql_conn" ? Boolean(oracle.sqlQuery) : Boolean(oracle.mongoQuery)
  );
  return relevant.length > 0 && relevant.every((oracle) => {
    try {
      return providers.providerFor(oracle) !== undefined;
    } catch {
      // Verification treats a cached selection failure as a contained oracle
      // failure and does not fall back to the built-in DB verifier. Do not
      // require an otherwise-unused built-in connection credential here.
      return true;
    }
  });
}

function connectionDataPlaneCliOwnsAuth(pack: TargetPack, cell: EvaluationCell): boolean {
  const auth = pack.surfaces?.cli?.auth;
  return cell.surface === "cli"
    && Boolean(pack.sql_conn || pack.mongo_conn)
    && (!auth || auth.kind === "inherit");
}

function verifierExecutor(executor: ExecutorResults, cell: EvaluationCell, ns: string): ExecutorResults {
  if (!executor.results || typeof executor.results !== "object" || Array.isArray(executor.results)) {
    throw new Error("executor results must be an object");
  }
  return {
    ...executor,
    profile: cell.harness.profile,
    harness: cell.harness.id,
    ns,
    surface: cell.surface,
    results: Object.fromEntries(Object.entries(executor.results).map(([taskId, result]) => {
      const { __task_base_url: _untrustedBaseUrl, ...reported } = result;
      return [taskId, reported];
    })),
  };
}

function cellVerificationClient(
  runtime: CellRuntimeDependencies,
  cell: EvaluationCell,
  pack: TargetPack,
  executor: ExecutorResults,
  credentials: Record<string, string>,
  targetAdapter: TargetAdapter | undefined,
  observed: ObservedRun | undefined,
  trace: readonly TraceStep[],
): BearerClient {
  if (!targetAdapter?.verificationClientOptions) {
    return runtime.verificationClient(pack, executor, credentials);
  }
  const options = targetAdapter.verificationClientOptions(deepFreeze(structuredClone({
    cell,
    pack,
    executor,
    credentials,
    observed,
    trace,
  })));
  return new BearerClient(options);
}

function observedTranscript(
  pack: TargetPack,
  path: string,
  credentials: CredentialSource,
): ObservedRun | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  try {
    return parseTranscript(path, {
      baseUrl: resolveEnvTemplate(pack.base_url, credentials),
      cliBin: pack.surfaces?.cli?.bin,
      sdkPackage: pack.surfaces?.sdk?.package,
      mcpServer: pack.surfaces?.mcp?.server,
    });
  } catch {
    return undefined;
  }
}

function requiredTrace(path: string, artifactDir: string): TraceStep[] {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("required trace artifact must be a regular file");
  const rel = relative(realpathSync(artifactDir), realpathSync(path));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("required trace artifact must resolve inside the artifact directory");
  }
  return loadRequiredTrace(path);
}

function assertRegularCellArtifact(path: string, artifactDir: string, label: string): void {
  const rootStat = lstatSync(artifactDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("artifact directory must remain a real directory");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const rel = relative(realpathSync(artifactDir), realpathSync(path));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside the artifact directory`);
  }
}

function exactSecretValues(
  pack: TargetPack,
  credentialSets: readonly Readonly<Record<string, string>>[],
  provisioning: HarnessProvisioning,
  executor: ExecutorResults,
  extensionSecrets: readonly string[] = [],
): string[] {
  const values = new Set([
    ...credentialSets.flatMap((credentials) => Object.values(credentials)),
    ...provisioningSecretValues(provisioning),
    ...extensionSecrets,
  ]);
  for (const task of pack.tasks) {
    const reported = executor.results[task.id];
    if (!reported) continue;
    for (const oracle of task.oracles) {
      for (const field of [oracle.authField, oracle.sqlConnField]) {
        const value = field ? reported[field] : undefined;
        if (typeof value === "string") values.add(value);
      }
    }
  }
  return [...values].filter(Boolean).sort((a, b) => b.length - a.length);
}

function provisioningSecretValues(provisioning: HarnessProvisioning): string[] {
  const secretName = /(?:TOKEN|KEY|SECRET|PASSWORD|PASS|PAT|DATABASE_URL|CONNECTION_STRING|URI|DSN|JWT)/i;
  return Object.entries(provisioning.env)
    .filter(([name, value]) => secretName.test(name) && value.length > 0)
    .map(([, value]) => value);
}

function scrubText(value: string, secrets: readonly string[]): string {
  if (secrets.some((secret) => secret.length < 4 && value.includes(secret))) {
    return "<redacted-sensitive-text>";
  }
  let scrubbed = value;
  for (const secret of secrets) {
    if (secret.length >= 4) scrubbed = scrubbed.split(secret).join("<redacted>");
  }
  return redactHarnessArtifactText(scrubbed);
}

interface ArtifactDirectoryIdentity {
  realpath: string;
  dev: number;
  ino: number;
}

function artifactDirectoryIdentity(path: string): ArtifactDirectoryIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`artifact directory must be a real directory: ${path}`);
  }
  return { realpath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertArtifactDirectoryIdentity(path: string, expected: ArtifactDirectoryIdentity): void {
  const current = artifactDirectoryIdentity(path);
  if (current.realpath !== expected.realpath || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`artifact directory identity changed during cell execution: ${path}`);
  }
}

function replaceFileWithoutFollowing(path: string, value: string): void {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`artifact parent must be a real directory: ${parent}`);
  }
  const temporary = `${path}.ax-eval-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeArtifactPath(path: string): void {
  try {
    const stat = lstatSync(path);
    rmSync(path, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readRegularFileNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`artifact is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function scrubArtifacts(
  paths: ReturnType<typeof defaultInvokePaths>,
  secrets: readonly string[],
  homePaths: readonly (string | undefined)[] = [],
  expectedRoot?: ArtifactDirectoryIdentity,
  expectedHomeRoot?: ArtifactDirectoryIdentity,
): void {
  const artifactRoot = dirname(paths.resultsPath);
  try {
    if (expectedRoot) assertArtifactDirectoryIdentity(artifactRoot, expectedRoot);
  } catch {
    return;
  }
  for (const path of [
    paths.resultsPath,
    paths.tracePath,
    paths.stdoutPath,
    paths.stderrPath,
    paths.transcriptPath,
    paths.metaPath,
  ]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      replaceFileWithoutFollowing(path, scrubText(readRegularFileNoFollow(path).toString("utf8"), secrets));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const visit = (path: string): void => {
    try {
      if (!existsSync(path)) return;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) visit(resolve(path, entry));
        return;
      }
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return;
      const raw = readRegularFileNoFollow(path);
      if (raw.includes(0)) return;
      replaceFileWithoutFollowing(path, scrubText(raw.toString("utf8"), secrets));
    } catch {
      // A harness may remove cache files while exiting; primary artifacts above
      // remain authoritative and must still produce a normalized record.
    }
  };
  const allowedHomeRoot = resolve(dirname(paths.resultsPath), ".invoke-home");
  try {
    if (expectedHomeRoot) assertArtifactDirectoryIdentity(allowedHomeRoot, expectedHomeRoot);
  } catch {
    return;
  }
  for (const home of new Set(homePaths.filter((path): path is string => Boolean(path)))) {
    const rel = relative(allowedHomeRoot, resolve(home));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) continue;
    visit(resolve(home));
  }
}

function scrubOutcomes(outcomes: RoundtripOutcome[], secrets: readonly string[]): RoundtripOutcome[] {
  return outcomes.map((outcome) => ({
    ...outcome,
    error: outcome.error === null ? null : scrubText(outcome.error, secrets),
    oracleResults: outcome.oracleResults.map((result) => ({
      ...result,
      detail: scrubText(result.detail, secrets),
    })),
  }));
}

function scrubDiscovery(
  discovery: ProfileRun["discovery"],
  secrets: readonly string[],
): ProfileRun["discovery"] {
  if (!discovery) return discovery;
  return {
    ...discovery,
    metrics: discovery.metrics.map((metric) => ({
      ...metric,
      detail: scrubText(metric.detail, secrets),
    })),
  };
}

function executionProfileRun(args: {
  cell: EvaluationCell;
  executor: ExecutorResults;
  outcomes: RoundtripOutcome[];
  trace: TraceStep[];
  discovery: ProfileRun["discovery"];
  discoverySource: ProfileRun["discoverySource"];
  invoke: InvokeRunResult;
  paths: ReturnType<typeof defaultInvokePaths>;
}): ProfileRun {
  const metrics = args.invoke.metrics;
  return {
    profile: args.cell.harness.profile,
    harness: args.cell.harness.id,
    model: args.executor.model ?? args.cell.harness.model,
    outcomes: args.outcomes,
    surface: args.cell.surface,
    ns: args.executor.ns,
    trace: args.trace,
    discovery: args.discovery,
    discoverySource: args.discoverySource,
    efficiency: {
      latency_ms: metrics?.duration_ms ?? args.invoke.durationMs ?? null,
      total_duration_ms: metrics?.total_duration_ms ?? args.invoke.durationMs ?? null,
      tool_call_count: null,
      token_usage: metrics?.token_usage ?? null,
      token_cost: metrics?.cost_usd ?? null,
      cost_usd: metrics?.cost_usd ?? null,
      harness_version_raw: metrics?.harness_version_raw ?? null,
      harness_version_semver: metrics?.harness_version_semver ?? null,
      run_batch_id: args.cell.batch_id,
      validity_status: args.invoke.validity_status ?? null,
      first_action_latency_ms: args.invoke.first_action_latency_ms ?? null,
      transcript_event_count: args.invoke.transcript_event_count ?? null,
      action_occurred: args.invoke.action_occurred ?? null,
    },
    evidence: {
      results: [basename(args.paths.resultsPath)],
      trace: [basename(args.paths.tracePath)],
      transcript: basename(args.paths.transcriptPath),
    },
  };
}

export async function runCell(
  input: EvaluationCell,
  options: RunCellOptions,
): Promise<NormalizedCellRecord> {
  return runCellWithRuntime(input, options, DEFAULT_RUNTIME);
}

/** Dependency-injected form for controllers that need an explicit runtime boundary. */
export async function runCellWithRuntime(
  input: EvaluationCell,
  options: RunCellOptions,
  runtime: CellRuntimeDependencies,
): Promise<NormalizedCellRecord> {
  const cell = deepFreeze(EvaluationCellSchema.parse(input));
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("cell run aborted");

  const cwd = resolve(cell.run_context.cwd);
  const packPath = resolveWithin(cwd, cell.pack.path, "pack.path");
  const artifactDir = resolveWithin(cwd, cell.run_context.artifact_dir, "run_context.artifact_dir");
  const pack = deepFreeze(loadPack(packPath));
  assertCellMatchesPack(cell, pack, packPath, cwd, options);

  mkdirSync(artifactDir, { recursive: true });
  ensureInvokeHomeRoot(cwd, artifactDir);
  const artifactIdentity = artifactDirectoryIdentity(artifactDir);
  const invokeHomeIdentity = artifactDirectoryIdentity(resolve(artifactDir, ".invoke-home"));
  const stem = stableSlug(cell.cell_id, "cell");
  const paths = defaultInvokePaths(artifactDir, stem, cell.harness.id);
  for (const path of [
    paths.promptPath,
    paths.resultsPath,
    paths.tracePath,
    paths.stdoutPath,
    paths.stderrPath,
    paths.transcriptPath,
    paths.metaPath,
    paths.codexSchemaPath,
  ]) {
    if (path) removeArtifactPath(path);
  }
  const startedAt = runtime.now().toISOString();
  const credentials = scopedCredentials(cell, options.credentials);
  const verificationCredentials = options.verificationCredentials === undefined
    ? credentials
    : normalizedCredentials(options.verificationCredentials);
  const resolutionCredentials = { ...credentials, ...verificationCredentials };
  const credentialSecrets = [...Object.values(credentials), ...Object.values(verificationCredentials)];
  let oracleProviders: OracleProviderRegistry;
  let provisioningProvider: ProvisioningProvider | undefined;
  let healthCheckProvider: HealthCheckProvider | undefined;
  let targetAdapter: TargetAdapter | undefined;
  let providerProvenance: CellProviderReference[];
  try {
    if (options.extensions?.registry && options.extensions.oracleProviders) {
      throw new Error("pass either extensions.registry or the legacy oracleProviders option, not both");
    }
    const extensionRegistry = options.extensions?.registry ?? createRuntimeExtensionRegistry();
    const resolvedExtensions = resolveRuntimeExtensions(extensionRegistry, { cell, pack });
    oracleProviders = options.extensions?.oracleProviders ?? resolvedExtensions.oracleProviders;
    provisioningProvider = resolvedExtensions.provisioningProviders.providerFor({ cell, pack });
    healthCheckProvider = resolvedExtensions.healthCheckProviders.providerFor({ cell, pack });
    targetAdapter = resolvedExtensions.targetAdapter;
    providerProvenance = selectedProviderProvenance(
      cell,
      pack,
      oracleProviders,
      provisioningProvider,
      healthCheckProvider,
      targetAdapter,
    );
  } catch (error) {
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "invoke-failed",
      stage: "preflight",
      message: safeMessage(error, credentialSecrets),
    });
  }
  const missingDeclared = cell.required_credentials.filter((name) => !credentials[name]);
  const connectionDataPlaneCli = connectionDataPlaneCliOwnsAuth(pack, cell);
  const selectedTasks = tasksForSurface(pack, cell.surface);
  const missingPack = describeRequiredEnv(pack, resolutionCredentials, {
    tasks: selectedTasks,
    includeAuth: false,
  })
    .filter((requirement) => !(
      (requirement.role === "sql_conn" || requirement.role === "mongo_conn")
      && providerOwnsConnectionRole(selectedTasks, oracleProviders, requirement.role)
    ))
    .filter((requirement) => requirement.required && !requirement.set)
    .map((requirement) => requirement.env);
  const missingVerifierRequirements = options.verificationCredentials === undefined
    ? []
    : describeRequiredEnv(pack, verificationCredentials, {
        tasks: selectedTasks,
        includeAuth: true,
      })
      .filter((requirement) => !(
        (requirement.role === "sql_conn" || requirement.role === "mongo_conn")
        && providerOwnsConnectionRole(selectedTasks, oracleProviders, requirement.role)
      ))
      .filter((requirement) => requirement.required && !requirement.set)
      .map((requirement) => requirement.role === "auth"
        ? pack.auth?.verify_env ?? pack.auth?.env ?? "ASANA_VERIFY_PAT"
        : requirement.env);
  const auth = connectionDataPlaneCli
    ? { blocked: null, missing: [] }
    : surfaceAuthStatus(pack, cell.surface, credentials);
  const missing = [...new Set([...missingDeclared, ...missingPack, ...missingVerifierRequirements, ...auth.missing])];
  if (missing.length || auth.blocked) {
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: auth.blocked ?? "missing-credential",
      stage: "preflight",
      message: `missing required credential env name(s): ${missing.join(", ") || "surface OAuth configuration"}`,
      providerProvenance,
    });
  }

  const detection = runtime.detectHarness(
    cell.harness.id,
    detectionEnvironment(artifactDir),
    options.sandbox,
    cwd,
  );
  if (!detection.ok) {
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "missing-harness",
      stage: "preflight",
      message: detection.detail ?? detection.reason ?? `unable to detect ${cell.harness.id}`,
      providerProvenance,
    });
  }

  if (healthCheckProvider) {
    try {
      const evidence = await healthCheckProvider.check({
        cell,
        pack,
        credentials: Object.freeze({ ...verificationCredentials }),
        signal: options.signal,
      });
      if (!Array.isArray(evidence) || evidence.some((entry) =>
        !entry || !["pass", "warn", "fail"].includes(entry.status) || typeof entry.message !== "string")) {
        throw new Error(`health-check provider "${healthCheckProvider.id}" returned invalid evidence`);
      }
      const failures = evidence.filter((entry) => entry.status === "fail");
      if (failures.length) {
        return terminalRecord({
          cell,
          pack,
          paths,
          startedAt,
          completedAt: runtime.now().toISOString(),
          blocked: "health-check-failed",
          stage: "preflight",
          message: safeMessage(
            `health-check provider "${healthCheckProvider.id}": ${failures.map((entry) => entry.message).join("; ")}`,
            Object.values(verificationCredentials),
          ),
          providerProvenance,
        });
      }
    } catch (error) {
      return terminalRecord({
        cell,
        pack,
        paths,
        startedAt,
        completedAt: runtime.now().toISOString(),
        blocked: "health-check-failed",
        stage: "preflight",
        message: `health-check provider "${healthCheckProvider.id}" failed`,
        providerProvenance,
      });
    }
  }

  let provisioning: HarnessProvisioning;
  let extensionSecrets: string[] = [];
  try {
    let extensionProvisioning: ProvisioningEvidence | undefined;
    if (provisioningProvider) {
      const inspectionContext = {
        cell,
        pack,
        cwd,
        artifactDir,
        signal: options.signal,
      };
      const inspection = await provisioningProvider.inspect(inspectionContext);
      if (!inspection || typeof inspection.ready !== "boolean"
        || (inspection.detail !== undefined && typeof inspection.detail !== "string")) {
        throw new Error(`provisioning provider "${provisioningProvider.id}" returned an invalid inspection`);
      }
      if (!inspection.ready) {
        throw new Error(
          `provisioning provider "${provisioningProvider.id}" is not ready${inspection.detail ? `: ${inspection.detail}` : ""}`,
        );
      }
      try {
        extensionProvisioning = deepFreeze(structuredClone(await provisioningProvider.provision({
          ...inspectionContext,
          credentials: Object.freeze(harnessCredentials(pack, credentials)),
        })));
      } catch {
        throw new Error(`provisioning provider "${provisioningProvider.id}" failed`);
      }
      extensionSecrets = Object.values(extensionProvisioning.env ?? {})
        .filter((value): value is string => typeof value === "string");
    }
    const baseEnv = childEnvironment(pack, credentials);
    const coreProvisioning = await runtime.provisionHarness({
      pack,
      harness: cell.harness.id,
      surface: cell.surface,
      paths,
      cwd,
      env: baseEnv,
      allowDownloads: false,
      allowAmbientHarnessAuth: false,
    });
    provisioning = mergeExtensionProvisioning(
      coreProvisioning,
      extensionProvisioning,
      provisioningProvider,
      baseEnv,
      { ...credentials, ...verificationCredentials },
      cwd,
      artifactDir,
    );
  } catch (error) {
    scrubArtifacts(paths, credentialSecrets, [], artifactIdentity, invokeHomeIdentity);
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "invoke-failed",
      stage: "provision",
      message: safeMessage(error, credentialSecrets),
      providerProvenance,
    });
  }

  const profile = {
    ...getProfile(cell.harness.profile),
    model: cell.harness.model,
    effort: cell.harness.effort,
  };
  const ns = executionNamespace(pack, cell);
  const prompt = buildExecutorPrompt({
    pack,
    profile,
    ns,
    resultsPath: paths.resultsPath,
    tracePath: paths.tracePath,
    surface: getSurface(cell.surface),
  });
  assertArtifactDirectoryIdentity(artifactDir, artifactIdentity);
  replaceFileWithoutFollowing(paths.promptPath, prompt);

  const env = { ...childEnvironment(pack, credentials), ...provisioning.env };
  const failureSecrets = [
    ...credentialSecrets,
    ...provisioningSecretValues(provisioning),
    ...extensionSecrets,
  ];
  let invoke: InvokeRunResult;
  try {
    invoke = await runtime.invokeHarness({
      pack,
      harness: cell.harness.id,
      profile: cell.harness.profile,
      surface: cell.surface,
      ns,
      paths,
      cwd,
      model: cell.harness.model,
      effort: cell.harness.effort,
      timeoutMs: cell.run_context.invoke_timeout_ms || undefined,
      firstActionTimeoutMs: cell.run_context.first_action_timeout_ms || undefined,
      retries: cell.run_context.invoke_retries,
      env,
      replaceEnv: true,
      provisioning: provisioning.meta,
      harnessDetection: detection,
      runBatchId: cell.batch_id,
      requireTrace: true,
      sandbox: options.sandbox,
    });
  } catch (error) {
    scrubArtifacts(paths, failureSecrets, [provisioning.env.HOME, provisioning.env.CODEX_HOME], artifactIdentity, invokeHomeIdentity);
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "invoke-failed",
      stage: "invoke",
      status: "failed",
      executionNamespace: ns,
      message: safeMessage(error, failureSecrets),
      providerProvenance,
    });
  }

  if (options.signal?.aborted) {
    scrubArtifacts(paths, failureSecrets, [provisioning.env.HOME, provisioning.env.CODEX_HOME], artifactIdentity, invokeHomeIdentity);
    throw options.signal.reason ?? new Error("cell run aborted");
  }
  let executor: ExecutorResults;
  let trace: TraceStep[];
  try {
    assertArtifactDirectoryIdentity(artifactDir, artifactIdentity);
    assertRegularCellArtifact(paths.resultsPath, artifactDir, "executor results artifact");
    trace = requiredTrace(paths.tracePath, artifactDir);
    executor = verifierExecutor(loadResults(paths.resultsPath), cell, ns);
  } catch (error) {
    scrubArtifacts(paths, failureSecrets, [provisioning.env.HOME, provisioning.env.CODEX_HOME], artifactIdentity, invokeHomeIdentity);
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "invoke-failed",
      stage: "invoke",
      status: "failed",
      executionNamespace: ns,
      message: safeMessage(error, failureSecrets),
      providerProvenance,
    });
  }

  const observed = observedTranscript(pack, paths.transcriptPath, resolutionCredentials);
  let outcomes: RoundtripOutcome[];
  let verifyError: string | undefined;
  try {
    const client = cellVerificationClient(
      runtime,
      cell,
      pack,
      executor,
      verificationCredentials,
      targetAdapter,
      observed,
      trace,
    );
    outcomes = await runtime.verify(
      pack,
      executor,
      client,
      cell,
      observed,
      trace,
      oracleProviders,
      verificationCredentials,
    );
  } catch (error) {
    verifyError = safeMessage(error, Object.values(verificationCredentials));
    outcomes = failedOutcomes(pack, cell, verifyError);
  }

  let discovery: ProfileRun["discovery"];
  let discoverySource: ProfileRun["discoverySource"];
  if (pack.discovery?.product) {
    try {
      const client = cellVerificationClient(
        runtime,
        cell,
        pack,
        executor,
        verificationCredentials,
        targetAdapter,
        observed,
        trace,
      );
      if (observed) {
        discovery = await scoreDiscovery(
          pack.discovery,
          observedToDiscovery(observed, executor.ns, cell.surface),
          client,
          { surface: cell.surface, apiStyle: pack.api_style },
        );
        discoverySource = "observed";
      } else if (executor.discovery) {
        discovery = await scoreDiscovery(pack.discovery, executor.discovery, client, {
          surface: cell.surface,
          apiStyle: pack.api_style,
        });
        discoverySource = "self-report";
      }
    } catch {
      // Discovery is diagnostic. Independent task read-back remains authoritative.
    }
  }

  const secrets = exactSecretValues(
    pack,
    [credentials, verificationCredentials],
    provisioning,
    executor,
    extensionSecrets,
  );
  verifyError = verifyError ? scrubText(verifyError, secrets) : undefined;
  outcomes = scrubOutcomes(outcomes, secrets);
  discovery = scrubDiscovery(discovery, secrets);
  scrubArtifacts(paths, secrets, [provisioning.env.HOME, provisioning.env.CODEX_HOME], artifactIdentity, invokeHomeIdentity);

  const profileRun = executionProfileRun({
    cell,
    executor,
    outcomes,
    trace: trace.length ? trace : observed ? observedToTrace(observed) : [],
    discovery,
    discoverySource,
    invoke,
    paths,
  });
  const base = buildNormalizedResult(pack, cell.surface, cell.harness.id, [profileRun], null);
  const completedAt = runtime.now().toISOString();
  const record = {
    ...base,
    schema: NORMALIZED_CELL_RECORD_SCHEMA,
    generated_at: completedAt,
    standard_set_version: cell.evaluation_set_version,
    model: executor.model ?? cell.harness.model,
    run_batch_id: cell.batch_id,
    record_id: cell.cell_id,
    cell_id: cell.cell_id,
    batch_id: cell.batch_id,
    evaluation_set_id: cell.evaluation_set_id,
    evaluation_set_version: cell.evaluation_set_version,
    pack_content_hash: cell.pack.content_hash,
    source_commit_sha: cell.source_commit_sha,
    execution_namespace: ns,
    ...(discovery ? { discovery } : {}),
    ...(discoverySource ? { discovery_source: discoverySource } : {}),
    target_id: cell.target_id,
    trial: cell.trial,
    effort: cell.harness.effort,
    requested_model: cell.harness.model,
    started_at: startedAt,
    completed_at: completedAt,
    status: invoke.ok && !verifyError ? "completed" : "failed",
    error: verifyError
      ? { stage: "verify", message: verifyError }
      : invoke.ok ? null : {
          stage: "invoke",
          message: safeMessage(invoke.error ?? "harness invocation failed", secrets),
        },
    ...recordProvenance(providerProvenance),
    ...(invoke.sandbox_provenance ? { sandbox_provenance: invoke.sandbox_provenance } : {}),
    task_results: outcomes,
    artifacts: artifactNames(paths),
  };
  return NormalizedCellRecordSchema.parse(record);
}
