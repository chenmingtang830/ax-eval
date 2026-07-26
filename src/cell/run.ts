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
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { loadPack } from "../config.js";
import { scoreDiscovery } from "../generate/discovery.js";
import { buildBlockedResult, buildNormalizedResult } from "../generate/record.js";
import { checkCellApproval, packFileContentHash } from "../generate/review.js";
import { buildVerificationClientOptions } from "../generate/verification-client.js";
import {
  createOracleProviderRegistry,
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
  redactHarnessArtifactText,
  runInvokeHarness,
  type InvokeDetection,
  type InvokeRunOptions,
  type InvokeRunResult,
} from "../harness/invoke.js";
import { buildExecutorPrompt, resolveNs, type TraceStep } from "../harness/executor.js";
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
  extensions?: {
    oracleProviders?: OracleProviderRegistry;
  };
  signal?: AbortSignal;
}

export interface CellRuntimeDependencies {
  now(): Date;
  detectHarness(id: EvaluationCell["harness"]["id"], env?: Record<string, string>): InvokeDetection;
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
  detectHarness: (id, env) => detectInvokeHarness(id, undefined, env, false),
  provisionHarness: provisionHarnessForSurface,
  invokeHarness: runInvokeHarness,
  verificationClient: (pack, executor, credentials) =>
    new BearerClient(buildVerificationClientOptions(pack, executor, credentials)),
  verify: (pack, executor, client, cell, observed, trace, oracleProviders, credentials) =>
    verifyGeneratedPack(pack, executor, client, cell.surface, observed, {
      oracleProviders,
      env: credentials,
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

function scopedCredentials(cell: EvaluationCell, source: CredentialSource): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of cell.required_credentials) {
    const value = source[name]?.trim();
    if (value) values[name] = value;
  }
  return values;
}

function childEnvironment(pack: TargetPack, credentials: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_PARENT_ENV) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  // A distinct verification credential is deliberately kept out of the host
  // agent process. It remains available to the independent read-back client.
  const verifierOnly = new Set([
    pack.auth?.verify_env,
    ...(pack.auth?.verify_env_aliases ?? []),
  ].filter((name): name is string => Boolean(name)));
  for (const [name, value] of Object.entries(credentials)) {
    if (!verifierOnly.has(name)) out[name] = value;
  }
  return out;
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
  blocked: "requires-oauth" | "missing-credential" | "missing-harness" | "invoke-failed";
  stage: "preflight" | "provision" | "invoke" | "verify";
  message: string;
  status?: "failed" | "blocked";
}): NormalizedCellRecord {
  const base = buildBlockedResult(args.pack, args.cell.surface, args.cell.harness.id, args.blocked);
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
    target_id: args.cell.target_id,
    trial: args.cell.trial,
    effort: args.cell.harness.effort,
    requested_model: args.cell.harness.model,
    started_at: args.startedAt,
    completed_at: args.completedAt,
    status: args.status ?? "blocked",
    error: { stage: args.stage, message: args.message },
    task_results: [],
    artifacts: artifactNames(args.paths),
  };
  return NormalizedCellRecordSchema.parse(record);
}

function assertCellMatchesPack(cell: EvaluationCell, pack: TargetPack, packPath: string): void {
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
  const approval = checkCellApproval(pack, packPath, cell.pack.content_hash);
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
  return relevant.length > 0 && relevant.every((oracle) => providers.providerFor(oracle) !== undefined);
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
  credentials: Record<string, string>,
  provisioning: HarnessProvisioning,
  executor: ExecutorResults,
): string[] {
  const values = new Set([...Object.values(credentials), ...provisioningSecretValues(provisioning)]);
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

/** Internal dependency-injected entry used by keyless/offline contract tests. */
export async function runCellWithRuntime(
  input: EvaluationCell,
  options: RunCellOptions,
  runtime: CellRuntimeDependencies,
): Promise<NormalizedCellRecord> {
  const cell = EvaluationCellSchema.parse(input);
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("cell run aborted");

  const cwd = resolve(cell.run_context.cwd);
  const packPath = resolveWithin(cwd, cell.pack.path, "pack.path");
  const artifactDir = resolveWithin(cwd, cell.run_context.artifact_dir, "run_context.artifact_dir");
  const pack = loadPack(packPath);
  assertCellMatchesPack(cell, pack, packPath);

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
  const oracleProviders = options.extensions?.oracleProviders ?? createOracleProviderRegistry();
  const missingDeclared = cell.required_credentials.filter((name) => !credentials[name]);
  const selectedTasks = tasksForSurface(pack, cell.surface);
  const missingPack = describeRequiredEnv(pack, credentials, {
    tasks: selectedTasks,
    includeAuth: false,
  })
    .filter((requirement) => !(
      (requirement.role === "sql_conn" || requirement.role === "mongo_conn")
      && providerOwnsConnectionRole(selectedTasks, oracleProviders, requirement.role)
    ))
    .filter((requirement) => requirement.required && !requirement.set)
    .map((requirement) => requirement.env);
  const auth = surfaceAuthStatus(pack, cell.surface, credentials);
  const missing = [...new Set([...missingDeclared, ...missingPack, ...auth.missing])];
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
    });
  }

  const detection = runtime.detectHarness(cell.harness.id, detectionEnvironment(artifactDir));
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
    });
  }

  let provisioning: HarnessProvisioning;
  try {
    provisioning = await runtime.provisionHarness({
      pack,
      harness: cell.harness.id,
      surface: cell.surface,
      paths,
      cwd,
      env: childEnvironment(pack, credentials),
      allowDownloads: false,
      allowAmbientHarnessAuth: false,
    });
  } catch (error) {
    scrubArtifacts(paths, Object.values(credentials), [], artifactIdentity, invokeHomeIdentity);
    return terminalRecord({
      cell,
      pack,
      paths,
      startedAt,
      completedAt: runtime.now().toISOString(),
      blocked: "invoke-failed",
      stage: "provision",
      message: safeMessage(error, Object.values(credentials)),
    });
  }

  const profile = {
    ...getProfile(cell.harness.profile),
    model: cell.harness.model,
    effort: cell.harness.effort,
  };
  const namespaceLabel = stableSlug(
    `${cell.batch_id}-${cell.cell_id}-${cell.harness.model}`,
    "cell",
  );
  const ns = resolveNs(pack.run_id, namespaceLabel, cell.trial);
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
  const failureSecrets = [...Object.values(credentials), ...provisioningSecretValues(provisioning)];
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
      message: safeMessage(error, failureSecrets),
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
      message: safeMessage(error, failureSecrets),
    });
  }

  const observed = observedTranscript(pack, paths.transcriptPath, credentials);
  let outcomes: RoundtripOutcome[];
  let verifyError: string | undefined;
  try {
    const client = runtime.verificationClient(pack, executor, credentials);
    outcomes = await runtime.verify(pack, executor, client, cell, observed, trace, oracleProviders, credentials);
  } catch (error) {
    verifyError = safeMessage(error, Object.values(credentials));
    outcomes = failedOutcomes(pack, cell, verifyError);
  }

  let discovery: ProfileRun["discovery"];
  let discoverySource: ProfileRun["discoverySource"];
  if (pack.discovery?.product) {
    try {
      const client = runtime.verificationClient(pack, executor, credentials);
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

  const secrets = exactSecretValues(pack, credentials, provisioning, executor);
  verifyError = verifyError ? scrubText(verifyError, secrets) : undefined;
  outcomes = scrubOutcomes(outcomes, secrets);
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
    task_results: outcomes,
    artifacts: artifactNames(paths),
  };
  return NormalizedCellRecordSchema.parse(record);
}
