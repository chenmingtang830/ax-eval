import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { NormalizedCellRecordSchema } from "ax-eval";
import { assertArenaRecordIdentity, type ArenaCellExecution } from "./cell.js";
import { BUBBLEWRAP_SANDBOX_ID, bubblewrapPolicyHash } from "./sandbox.js";
import {
  ARENA_BATCH_COMPLETION_SCHEMA,
  ARENA_BATCH_PLAN_SCHEMA,
  ARENA_BATCH_SCHEMA,
  ArenaBatchCompletionCellSchema,
  ArenaBatchCompletionSchema,
  ArenaBatchConfigurationSourceSchema,
  ArenaBatchConfigurationSchema,
  ArenaBatchManifestSchema,
  ArenaBatchPlanSchema,
  ArenaCellCleanupSchema,
  arenaBatchConfigurationHash,
  arenaExecutionMode,
  type ArenaBatchCompletion,
  type ArenaBatchConfiguration,
  type ArenaBatchConfigurationSource,
  type ArenaBatchManifest,
  type ArenaBatchPlan,
} from "./schemas.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameProviderPins(
  left: readonly { kind: string; id: string; version: string }[],
  right: readonly { kind: string; id: string; version: string }[],
): boolean {
  return sameStringSet(
    left.map((pin) => JSON.stringify([pin.kind, pin.id, pin.version])),
    right.map((pin) => JSON.stringify([pin.kind, pin.id, pin.version])),
  );
}

function manifestBytes(manifest: ArenaBatchManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function planBytes(plan: ArenaBatchPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-linked regular file: ${path}`);
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exclusiveDurableWrite(path: string, contents: string): void {
  const parent = dirname(path);
  const temporary = resolve(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (pathEntryExists(temporary)) {
      unlinkSync(temporary);
      const directory = openSync(parent, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
}

function assertManifestIntegrity(manifest: ArenaBatchManifest): void {
  const current = arenaBatchConfigurationHash(manifest.configuration);
  if (manifest.configuration_hash !== current) {
    throw new Error(`arena batch configuration hash mismatch (recorded ${manifest.configuration_hash}, computed ${current})`);
  }
}

function isPathEscape(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

function readPersistedSidecar(runRoot: string, path: string, label: string): {
  contents: Buffer;
  relativePath: string;
} {
  const root = resolve(runRoot);
  const absolute = resolve(path);
  const lexical = relative(root, absolute);
  if (!lexical || isPathEscape(lexical)) {
    throw new Error(`${label} is outside the arena run root: ${path}`);
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`arena run root must be a regular directory: ${root}`);
  }
  let current = root;
  for (const segment of lexical.split(/[\\/]/)) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path cannot traverse a symlink: ${current}`);
  }
  assertRegularFile(absolute, label);
  const physical = relative(realpathSync(root), realpathSync(absolute));
  if (!physical || isPathEscape(physical)) {
    throw new Error(`${label} escaped the physical arena run root: ${path}`);
  }
  return { contents: readFileSync(absolute), relativePath: lexical.replaceAll("\\", "/") };
}

function assertTursoToolAttestation(
  runRoot: string,
  record: ReturnType<typeof NormalizedCellRecordSchema.parse>,
  pin: NonNullable<ArenaBatchConfiguration["turso_cli"]>,
): void {
  const provider = record.provider_provenance?.find((entry) =>
    entry.kind === "provisioning"
      && entry.id === pin.provisioner.id
      && entry.version === pin.provisioner.version);
  if (!provider) throw new Error("Turso CLI batch cell is missing pinned provisioning provenance");
  const metadataPath = resolve(record.artifacts.base_dir, record.artifacts.invoke_metadata);
  const metadataFile = readPersistedSidecar(runRoot, metadataPath, "Turso invoke metadata");
  let decoded: unknown;
  try {
    decoded = JSON.parse(metadataFile.contents.toString("utf8"));
  } catch {
    throw new Error("Turso invoke metadata is not valid JSON");
  }
  const root = decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : {};
  const provisioning = root.provisioning && typeof root.provisioning === "object"
    ? root.provisioning as Record<string, unknown>
    : {};
  const extensionProvider = provisioning.extension_provider && typeof provisioning.extension_provider === "object"
    ? provisioning.extension_provider as Record<string, unknown>
    : {};
  const metadata = provisioning.extension_metadata && typeof provisioning.extension_metadata === "object"
    ? provisioning.extension_metadata as Record<string, unknown>
    : {};
  if (extensionProvider.id !== provider.id
    || extensionProvider.version !== provider.version
    || provider.id !== pin.provisioner.id
    || provider.version !== pin.provisioner.version
    || metadata.cli_version !== pin.version
    || metadata.cli_sha256 !== pin.sha256
    || typeof metadata.cli_binary !== "string") {
    throw new Error("Turso invoke metadata does not match the immutable tool pin");
  }
  const installRootStat = lstatSync(pin.install_root);
  const binaryStat = lstatSync(metadata.cli_binary);
  if (!installRootStat.isDirectory() || installRootStat.isSymbolicLink()
    || !binaryStat.isFile() || binaryStat.isSymbolicLink()) {
    throw new Error("Turso tool attestation requires a regular pinned install root and binary");
  }
  const binaryRelative = relative(realpathSync(pin.install_root), realpathSync(metadata.cli_binary));
  if (!binaryRelative || isPathEscape(binaryRelative)) {
    throw new Error("Turso tool binary is outside the immutable install root");
  }
  const actualHash = createHash("sha256").update(readFileSync(metadata.cli_binary)).digest("hex");
  if (actualHash !== pin.sha256) throw new Error("Turso tool binary no longer matches its immutable SHA-256 pin");
}

const ARTIFACT_NAMES = ["invoke_metadata", "results", "trace", "transcript"] as const;

function sealedRecordArtifacts(
  runRoot: string,
  execution: ArenaCellExecution,
  record: ReturnType<typeof NormalizedCellRecordSchema.parse>,
): Array<{ name: (typeof ARTIFACT_NAMES)[number]; path: string; sha256: string }> {
  const expectedRoot = resolve(execution.cell.run_context.cwd, execution.cell.run_context.artifact_dir);
  if (resolve(record.artifacts.base_dir) !== expectedRoot) {
    throw new Error(`cell artifact root does not match its immutable run context: ${execution.cell.cell_id}`);
  }
  const durableSidecars = new Set([resolve(execution.recordPath), resolve(execution.cleanupPath)]);
  const artifacts = ARTIFACT_NAMES.map((name) => {
    const fileName = record.artifacts[name];
    if (isAbsolute(fileName) || basename(fileName) !== fileName || fileName === "." || fileName === "..") {
      throw new Error(`record artifact ${name} must be a direct relative file name`);
    }
    const absolute = resolve(record.artifacts.base_dir, fileName);
    if (durableSidecars.has(absolute)) throw new Error(`record artifact ${name} overlaps a durable cell sidecar`);
    const artifact = readPersistedSidecar(runRoot, absolute, `record artifact ${name}`);
    return {
      name,
      path: artifact.relativePath,
      sha256: createHash("sha256").update(artifact.contents).digest("hex"),
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new Error(`record artifact files must be distinct: ${execution.cell.cell_id}`);
  }
  return artifacts;
}

function readBatchManifest(path: string): ArenaBatchManifest {
  assertRegularFile(path, "arena batch manifest");
  const contents = readFileSync(path, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = ArenaBatchManifestSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`${path} is not a valid immutable arena batch manifest`);
  if (contents !== manifestBytes(parsed.data)) {
    throw new Error(`${path} is not in the canonical immutable arena batch format`);
  }
  assertManifestIntegrity(parsed.data);
  return parsed.data;
}

function readBatchPlan(path: string): ArenaBatchPlan {
  assertRegularFile(path, "arena batch plan");
  const contents = readFileSync(path, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = ArenaBatchPlanSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`${path} is not a valid immutable arena batch plan`);
  if (contents !== planBytes(parsed.data)) {
    throw new Error(`${path} is not in the canonical immutable arena batch plan format`);
  }
  return parsed.data;
}

export function resolveBatchIdentity(
  runRoot: string,
  sourceCommitSha: string,
  now: Date,
  configuration: ArenaBatchConfiguration,
  configurationSource?: ArenaBatchConfigurationSource,
): ArenaBatchManifest {
  const parsedConfiguration = ArenaBatchConfigurationSchema.parse(configuration);
  const parsedConfigurationSource = configurationSource === undefined
    ? undefined
    : ArenaBatchConfigurationSourceSchema.parse(configurationSource);
  mkdirSync(runRoot, { recursive: true });
  const runRootStat = lstatSync(runRoot);
  if (!runRootStat.isDirectory() || runRootStat.isSymbolicLink()) {
    throw new Error(`arena batch run root must be a regular directory: ${runRoot}`);
  }
  const path = resolve(runRoot, "batch.json");
  const currentHash = arenaBatchConfigurationHash(parsedConfiguration);
  if (pathEntryExists(path)) {
    const existing = readBatchManifest(path);
    if (existing.source_commit_sha !== sourceCommitSha) {
      throw new Error(
        `run root batch source SHA mismatch (recorded ${existing.source_commit_sha}, current ${sourceCommitSha}); choose a new --run-dir`,
      );
    }
    if (existing.configuration_hash !== currentHash
      || JSON.stringify(existing.configuration_source) !== JSON.stringify(parsedConfigurationSource)
      || JSON.stringify(canonical(existing.configuration)) !== JSON.stringify(canonical(parsedConfiguration))) {
      throw new Error(
        `run root batch configuration mismatch (recorded ${existing.configuration_hash}, current ${currentHash}); choose a new --run-dir`,
      );
    }
    return existing;
  }

  const manifest = ArenaBatchManifestSchema.parse({
    schema: ARENA_BATCH_SCHEMA,
    batch_id: `batch-${randomUUID()}`,
    source_commit_sha: sourceCommitSha,
    created_at: now.toISOString(),
    configuration_hash: currentHash,
    ...(parsedConfigurationSource ? { configuration_source: parsedConfigurationSource } : {}),
    configuration: parsedConfiguration,
    expected_cells: parsedConfiguration.cells.map((cell) => cell.key),
  });
  try {
    exclusiveDurableWrite(path, manifestBytes(manifest));
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readBatchManifest(path);
    if (existing.source_commit_sha !== sourceCommitSha || existing.configuration_hash !== currentHash
      || JSON.stringify(existing.configuration_source) !== JSON.stringify(parsedConfigurationSource)
      || JSON.stringify(canonical(existing.configuration)) !== JSON.stringify(canonical(parsedConfiguration))) {
      throw new Error("concurrent arena batch creation produced a different immutable identity");
    }
    return existing;
  }
}

export function assertBatchManifest(runRoot: string, batch: ArenaBatchManifest): void {
  const parsed = ArenaBatchManifestSchema.parse(batch);
  assertManifestIntegrity(parsed);
  const path = resolve(runRoot, "batch.json");
  const persisted = readBatchManifest(path);
  if (manifestBytes(persisted) !== manifestBytes(parsed)) {
    throw new Error("immutable arena batch manifest changed during execution");
  }
}

export function loadBatchManifest(runRoot: string): ArenaBatchManifest {
  return readBatchManifest(resolve(runRoot, "batch.json"));
}

export function buildBatchPlan(batch: ArenaBatchManifest): ArenaBatchPlan {
  const parsedBatch = ArenaBatchManifestSchema.parse(batch);
  assertManifestIntegrity(parsedBatch);
  const packs = new Map(parsedBatch.configuration.packs.map((pack) => [pack.vendor, pack]));
  const harnesses = new Map(parsedBatch.configuration.harnesses.map((pin) => [pin.harness, pin]));
  const cells = parsedBatch.configuration.cells.map((cell) => {
    const pack = packs.get(cell.vendor);
    const harness = harnesses.get(cell.harness);
    if (!pack || !harness) {
      throw new Error(`arena batch cell ${cell.key} is missing its immutable pack or harness pin`);
    }
    const tursoCli = cell.vendor === "turso" && cell.surface === "cli"
      ? parsedBatch.configuration.turso_cli
      : undefined;
    return {
      key: cell.key,
      batch_id: parsedBatch.batch_id,
      source_commit_sha: parsedBatch.source_commit_sha,
      configuration_hash: parsedBatch.configuration_hash,
      vendor: cell.vendor,
      surface: cell.surface,
      harness: cell.harness,
      profile: cell.profile,
      effort: cell.effort,
      model: cell.model,
      trial: cell.trial,
      pack_file_hash: pack.file_hash,
      standard_set_version: pack.standard_set_version,
      harness_version_raw: harness.version_raw,
      harness_version_semver: harness.version_semver,
      execution: arenaExecutionMode(parsedBatch.configuration),
      host_credential_names: [...cell.host_credential_names],
      verification_credential_names: [...cell.verification_credential_names],
      reset_credential_names: [...cell.reset_credential_names],
      sandbox_scope_names: [...cell.sandbox_scope_names],
      provider_pins: cell.provider_pins.map((pin) => ({ ...pin })),
      reset_provider: cell.reset_provider ? { ...cell.reset_provider } : null,
      reset_required: parsedBatch.configuration.reset_required,
      invoke_timeout_seconds: parsedBatch.configuration.invoke_timeout_seconds,
      first_action_timeout_seconds: parsedBatch.configuration.first_action_timeout_seconds,
      invoke_retries: parsedBatch.configuration.invoke_retries,
      ...(tursoCli ? { turso_cli: { ...tursoCli } } : {}),
      ...(parsedBatch.configuration.sandbox ? {
        sandbox: {
          ...parsedBatch.configuration.sandbox,
          runtime_roots: [...parsedBatch.configuration.sandbox.runtime_roots],
        },
      } : {}),
    };
  });
  return ArenaBatchPlanSchema.parse({
    schema: ARENA_BATCH_PLAN_SCHEMA,
    batch_id: parsedBatch.batch_id,
    source_commit_sha: parsedBatch.source_commit_sha,
    configuration_hash: parsedBatch.configuration_hash,
    ...(parsedBatch.configuration_source ? { configuration_source: parsedBatch.configuration_source } : {}),
    batch_manifest_sha256: createHash("sha256").update(manifestBytes(parsedBatch)).digest("hex"),
    expected_cells: [...parsedBatch.expected_cells],
    cells,
  });
}

export function writeBatchPlan(runRoot: string, batch: ArenaBatchManifest): ArenaBatchPlan {
  assertBatchManifest(runRoot, batch);
  const plan = buildBatchPlan(batch);
  const path = resolve(runRoot, "batch-plan.json");
  if (pathEntryExists(path)) return loadBatchPlan(runRoot, batch);
  try {
    exclusiveDurableWrite(path, planBytes(plan));
    return plan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadBatchPlan(runRoot, batch);
  }
}

export function loadBatchPlan(runRoot: string, batch?: ArenaBatchManifest): ArenaBatchPlan {
  const persistedBatch = readBatchManifest(resolve(runRoot, "batch.json"));
  if (batch && manifestBytes(ArenaBatchManifestSchema.parse(batch)) !== manifestBytes(persistedBatch)) {
    throw new Error("immutable arena batch manifest changed before loading its plan");
  }
  const expected = buildBatchPlan(persistedBatch);
  const plan = readBatchPlan(resolve(runRoot, "batch-plan.json"));
  if (planBytes(plan) !== planBytes(expected)) {
    throw new Error("immutable arena batch plan drifted from its canonical batch manifest");
  }
  return plan;
}

export function buildBatchCompletion(
  runRoot: string,
  batch: ArenaBatchManifest,
  executions: readonly ArenaCellExecution[],
  now: Date,
): ArenaBatchCompletion {
  const parsedBatch = ArenaBatchManifestSchema.parse(batch);
  assertManifestIntegrity(parsedBatch);
  const cells = executions.map((execution) => {
    const recordFile = readPersistedSidecar(runRoot, execution.recordPath, "persisted cell record");
    const cleanupFile = readPersistedSidecar(runRoot, execution.cleanupPath, "persisted cleanup evidence");
    let recordJson: unknown;
    let cleanupJson: unknown;
    try {
      recordJson = JSON.parse(recordFile.contents.toString("utf8"));
      cleanupJson = JSON.parse(cleanupFile.contents.toString("utf8"));
    } catch {
      throw new Error(`persisted cell sidecars are not valid JSON: ${execution.cell.cell_id}`);
    }
    const record = NormalizedCellRecordSchema.parse(recordJson);
    const cleanup = ArenaCellCleanupSchema.parse(cleanupJson);
    assertArenaRecordIdentity(record, execution.cell);
    const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
    const recordHash = createHash("sha256").update(recordFile.contents).digest("hex");
    const cleanupBytes = `${JSON.stringify(cleanup, null, 2)}\n`;
    if (recordFile.contents.toString("utf8") !== recordBytes
      || cleanupFile.contents.toString("utf8") !== cleanupBytes
      || JSON.stringify(canonical(record)) !== JSON.stringify(canonical(execution.record))
      || JSON.stringify(canonical(cleanup)) !== JSON.stringify(canonical(execution.cleanup))) {
      throw new Error(`persisted cell artifact changed after controller validation: ${execution.cell.cell_id}`);
    }
    const key = `${execution.cell.target_id}/${execution.cell.surface}/${execution.cell.harness.id}/trial-${execution.cell.trial}`;
    const configured = parsedBatch.configuration.cells.find((cell) => cell.key === key);
    const configuredPack = parsedBatch.configuration.packs.find((pack) => pack.vendor === execution.cell.target_id);
    const configuredSandbox = parsedBatch.configuration.sandbox;
    const sandboxMatches = configuredSandbox
      ? record.sandbox_provenance?.id === BUBBLEWRAP_SANDBOX_ID
        && record.sandbox_provenance.version === configuredSandbox.policy_version
        && record.sandbox_provenance.implementation_sha256 === configuredSandbox.executable_sha256
        && record.sandbox_provenance.policy_sha256 === bubblewrapPolicyHash(configuredSandbox)
      : record.sandbox_provenance === undefined;
    if (!configured
      || execution.cell.batch_id !== parsedBatch.batch_id
      || execution.cell.source_commit_sha !== parsedBatch.source_commit_sha
      || execution.cell.evaluation_set_id !== parsedBatch.configuration.suite.name
      || execution.cell.evaluation_set_version !== configuredPack?.standard_set_version
      || execution.cell.target_id !== configured.vendor
      || execution.cell.surface !== configured.surface
      || execution.cell.harness.id !== configured.harness
      || execution.cell.harness.model !== configured.model
      || execution.cell.harness.profile !== configured.profile
      || execution.cell.harness.effort !== configured.effort
      || execution.cell.trial !== configured.trial
      || execution.cell.run_context.invoke_timeout_ms !== parsedBatch.configuration.invoke_timeout_seconds * 1_000
      || execution.cell.run_context.first_action_timeout_ms !== parsedBatch.configuration.first_action_timeout_seconds * 1_000
      || execution.cell.run_context.invoke_retries !== parsedBatch.configuration.invoke_retries
      || !sameStringSet(execution.cell.required_credentials, configured.host_credential_names)
      || !sameStringSet(execution.credentialNames.host, configured.host_credential_names)
      || !sameStringSet(execution.credentialNames.verification, configured.verification_credential_names)
      || !sameStringSet(execution.credentialNames.reset, configured.reset_credential_names)
      || !configuredPack
      || execution.pack.name !== configured.vendor
      || execution.pack.standard_set_version !== configuredPack.standard_set_version
      || !sameStringSet(execution.pack.sandbox_scope.map((scope) => scope.env), configured.sandbox_scope_names)
      || execution.cell.pack.content_hash !== configuredPack.file_hash
      || record.cell_id !== execution.cell.cell_id
      || record.batch_id !== parsedBatch.batch_id
      || record.source_commit_sha !== parsedBatch.source_commit_sha
      || record.evaluation_set_id !== parsedBatch.configuration.suite.name
      || record.evaluation_set_version !== configuredPack.standard_set_version
      || record.standard_set_version !== configuredPack.standard_set_version
      || record.pack_content_hash !== configuredPack.file_hash
      || record.target_id !== configured.vendor
      || record.surface !== configured.surface
      || record.harness !== configured.harness
      || record.trial !== configured.trial
      || record.requested_model !== configured.model
      || !sandboxMatches
      || !sameProviderPins(record.provider_provenance ?? [], configured.provider_pins)
      || cleanup.cell_id !== record.cell_id
      || cleanup.record_sha256 !== recordHash
      || (cleanup.status === "confirmed"
        ? !cleanup.provider || !configured.reset_provider
          || cleanup.provider.id !== configured.reset_provider.id
          || cleanup.provider.version !== configured.reset_provider.version
        : cleanup.provider !== undefined)
      || cleanup.namespace !== record.execution_namespace
      || resolve(cleanup.record_path) !== resolve(execution.recordPath)) {
      throw new Error(`arena batch execution ${key} does not match its immutable configuration and sidecars`);
    }
    if (configured.vendor === "turso" && configured.surface === "cli") {
      assertTursoToolAttestation(runRoot, record, parsedBatch.configuration.turso_cli!);
    }
    const artifacts = sealedRecordArtifacts(runRoot, execution, record);
    return ArenaBatchCompletionCellSchema.parse({
      key,
      record_id: record.record_id,
      record_path: recordFile.relativePath,
      record_hash: recordHash,
      cleanup_path: cleanupFile.relativePath,
      cleanup_hash: createHash("sha256").update(cleanupFile.contents).digest("hex"),
      artifacts,
      harness: execution.cell.harness.id,
      requested_model: execution.cell.harness.model,
      actual_model: record.model,
      harness_version_raw: record.harness_version_raw,
      harness_version_semver: record.harness_version_semver,
      status: record.status,
      cleanup_status: cleanup.status,
    });
  })
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const expected = [...parsedBatch.expected_cells].sort();
  const actual = cells.map((cell) => cell.key);
  if (new Set(actual).size !== actual.length
    || expected.length !== actual.length
    || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`arena batch is incomplete or non-comparable (expected ${expected.join(", ")}; completed ${actual.join(", ")})`);
  }
  const configuredCells = new Map(parsedBatch.configuration.cells.map((cell) => [cell.key, cell]));
  const harnessPins = new Map(parsedBatch.configuration.harnesses.map((pin) => [pin.harness, pin]));
  const identityDrift = cells.find((cell) => {
    const configured = configuredCells.get(cell.key);
    const pin = harnessPins.get(cell.harness);
    return !configured
      || cell.harness !== configured.harness
      || cell.requested_model !== configured.model
      || !pin
      || cell.harness_version_raw !== pin.version_raw
      || cell.harness_version_semver !== pin.version_semver;
  });
  if (identityDrift) {
    throw new Error(`arena batch cell ${identityDrift.key} does not match its configured harness, model, and version pin`);
  }
  const invalid = cells.find((cell) => cell.actual_model !== cell.requested_model
    || (parsedBatch.configuration.reset_required && cell.cleanup_status !== "confirmed"));
  if (invalid) {
    throw new Error(
      `arena batch cell ${invalid.key} is non-comparable: requested_model=${invalid.requested_model}, actual_model=${invalid.actual_model}, cleanup=${invalid.cleanup_status}`,
    );
  }
  for (const harness of ["codex", "claude-code"] as const) {
    const versions = new Set(cells
      .filter((cell) => cell.harness === harness)
      .map((cell) => `${cell.harness_version_raw}\0${cell.harness_version_semver}`));
    if (versions.size > 1) {
      throw new Error(`arena batch used multiple ${harness} harness versions; pin one version for the entire batch`);
    }
  }
  return ArenaBatchCompletionSchema.parse({
    schema: ARENA_BATCH_COMPLETION_SCHEMA,
    batch_id: parsedBatch.batch_id,
    source_commit_sha: parsedBatch.source_commit_sha,
    configuration_hash: parsedBatch.configuration_hash,
    completed_at: now.toISOString(),
    cells,
  });
}

export function writeBatchCompletion(
  runRoot: string,
  batch: ArenaBatchManifest,
  executions: readonly ArenaCellExecution[],
  now: Date,
  validate?: (completion: ArenaBatchCompletion) => void,
): ArenaBatchCompletion {
  assertBatchManifest(runRoot, batch);
  const completion = buildBatchCompletion(runRoot, batch, executions, now);
  validate?.(completion);
  exclusiveDurableWrite(
    resolve(runRoot, "batch-completion.json"),
    `${JSON.stringify(completion, null, 2)}\n`,
  );
  return completion;
}
