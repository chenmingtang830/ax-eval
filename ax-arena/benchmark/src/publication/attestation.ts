import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, posix, resolve } from "node:path";
import { z } from "zod";
import {
  ArenaBatchCompletionSchema,
  ArenaBatchConfigurationSchema,
  ArenaBatchManifestSchema,
  type ArenaBatchCompletion,
  type ArenaBatchConfiguration,
  type ArenaBatchManifest,
} from "../controller/schemas.js";
import {
  readCanonicalJson,
  readPinnedFile,
  type PinnedFile,
} from "./filesystem.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const EXPECTED_REPOSITORY = "chenmingtang830/ax-eval";
const TRUSTED_WORKFLOW = ".github/workflows/trusted-sandbox-records.yml";
const GH_PATH = "/usr/bin/gh";
const APPROVED_SIGNER_ENV = "AX_ARENA_APPROVED_SIGNER_SHA";

const SourceArtifactReferenceSchema = z.object({
  path: z.string().min(1).refine((path) =>
    path.startsWith("ax-arena/benchmark/daeb/")
    && !path.includes("\\") && !path.includes("\0")
    && posix.normalize(path) === path
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "source artifact path must be canonical and contained"),
  sha256: z.string().regex(SHA256),
}).strict();

const RuntimeReferenceSchema = z.object({
  path: z.literal("runtime-manifest.json"),
  sha256: z.string().regex(SHA256),
}).strict();
const ConfigurationReferenceSchema = z.object({
  path: z.literal("configuration.json"),
  sha256: z.string().regex(SHA256),
}).strict();
const BatchReferenceSchema = z.object({
  path: z.literal("batch.json"),
  sha256: z.string().regex(SHA256),
}).strict();
const CompletionReferenceSchema = z.object({
  path: z.literal("batch-completion.json"),
  sha256: z.string().regex(SHA256),
}).strict();

export const TrustedRunSubjectSchema = z.object({
  schema: z.literal("ax.arena-trusted-run-subject/v1"),
  repository: z.literal(EXPECTED_REPOSITORY),
  source_commit_sha: z.string().regex(SOURCE_SHA),
  protected_default_branch: z.literal("main"),
  workflow: z.object({
    ref: z.literal(`${EXPECTED_REPOSITORY}/${TRUSTED_WORKFLOW}@refs/heads/main`),
    sha: z.string().regex(SOURCE_SHA),
    run_id: z.string().regex(/^\d+$/),
    run_attempt: z.string().regex(/^[1-9]\d*$/),
    environment: z.literal("trusted-sandbox"),
  }).strict(),
  runtime: z.object({
    lock_path: z.literal("ax-arena/benchmark/trusted-runtime/runtime-lock.json"),
    lock_sha256: z.string().regex(SHA256),
    container_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    tools_tree_sha256: z.string().regex(SHA256),
    manifest: RuntimeReferenceSchema,
  }).strict(),
  configuration: ConfigurationReferenceSchema,
  batch: z.object({
    id: z.string().min(1).regex(/\S/),
    configuration_hash: z.string().regex(SHA256),
    completed_cells: z.number().int().positive().safe(),
    manifest: BatchReferenceSchema,
    completion: CompletionReferenceSchema,
  }).strict(),
  source_artifacts: z.array(SourceArtifactReferenceSchema).min(1).max(16_384),
}).strict().superRefine((subject, context) => {
  const paths = subject.source_artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: "custom", path: ["source_artifacts"], message: "source artifacts must be unique and canonically sorted" });
  }
});
export type TrustedRunSubject = z.infer<typeof TrustedRunSubjectSchema>;

const RuntimeManifestSchema = z.object({
  schema: z.literal("ax.arena-trusted-runtime-manifest/v1"),
  platform: z.literal("linux/amd64"),
  runtime_lock_path: z.literal("ax-arena/benchmark/trusted-runtime/runtime-lock.json"),
  runtime_lock_sha256: z.string().regex(SHA256),
  sysroot: z.literal("/opt/ax-arena-runtime/rootfs"),
  container: z.object({
    image: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    node_version: z.string().min(1),
  }).strict(),
  node_executable_sha256: z.string().regex(SHA256),
  tools_tree_sha256: z.string().regex(SHA256),
  entries: z.array(z.unknown()),
}).strict();
export type TrustedRuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

export interface VerifiedHostedAttestation {
  subject: TrustedRunSubject;
  subjectFile: PinnedFile;
  runtimeManifest: TrustedRuntimeManifest;
  runtimeManifestFile: PinnedFile;
  configuration: ArenaBatchConfiguration;
  configurationFile: PinnedFile;
  batch: ArenaBatchManifest;
  batchFile: PinnedFile;
  completion: ArenaBatchCompletion;
  completionFile: PinnedFile;
  detachedBundles: Buffer;
  verification: {
    schema: "ax.github-oidc-attestation-verification/v1";
    repository: string;
    signer_workflow: string;
    workflow_ref: string;
    workflow_sha: string;
    run_id: string;
    run_attempt: string;
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvedSignerSha(): string {
  const value = process.env[APPROVED_SIGNER_ENV]?.trim();
  if (!value || !SOURCE_SHA.test(value)) {
    throw new Error(`trusted publication requires external ${APPROVED_SIGNER_ENV}`);
  }
  return value;
}

function directChild(root: string, path: string, label: string): string {
  if (path !== basename(path) || path.includes("\\") || path.includes("\0")) {
    throw new Error(`${label} must be a direct child of the trusted run root`);
  }
  return resolve(root, path);
}

function referencedCanonical<T>(
  runRoot: string,
  reference: { path: string; sha256: string },
  label: string,
  parse: (input: unknown) => T,
): { file: PinnedFile; value: T } {
  const result = readCanonicalJson(runRoot, directChild(runRoot, reference.path, label), label, parse);
  if (sha256(result.file.bytes) !== reference.sha256) {
    throw new Error(`${label} does not match its detached attestation hash`);
  }
  return result;
}

function pinnedVerifier(): { sha256: string; version: string } {
  const stat = lstatSync(GH_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022) !== 0
    || realpathSync(GH_PATH) !== GH_PATH) {
    throw new Error("hosted attestation verifier must be the root-owned, non-writable /usr/bin/gh regular file");
  }
  const descriptor = openSync(GH_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash("sha256");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== 0 || (opened.mode & 0o022) !== 0) {
      throw new Error("hosted attestation verifier changed during validation");
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("hosted attestation verifier changed during validation");
    }
  } finally {
    closeSync(descriptor);
  }
  const version = spawnSync(GH_PATH, ["--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 64 * 1024,
  });
  const firstLine = version.stdout?.split(/\r?\n/, 1)[0]?.trim();
  if (version.error || version.status !== 0 || !firstLine?.startsWith("gh version ")) {
    throw new Error("hosted attestation verifier version check failed");
  }
  return { sha256: digest.digest("hex"), version: firstLine };
}

function writePinnedCopy(directory: string, name: string, bytes: Buffer): string {
  const path = resolve(directory, name);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== bytes.length) throw new Error("attestation verification copy changed during write");
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function withPinnedVerificationCopies<T>(
  subjectBytes: Buffer,
  detachedBundles: Buffer | undefined,
  verify: (subjectPath: string, bundlesPath?: string) => T,
): T {
  const directory = mkdtempSync(resolve(tmpdir(), "ax-arena-attestation-"));
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("attestation verification scratch must be a private directory");
    }
    const subjectPath = writePinnedCopy(directory, "trusted-run-subject.json", subjectBytes);
    const bundlesPath = detachedBundles === undefined
      ? undefined
      : writePinnedCopy(directory, "github-attestation-bundles.jsonl", detachedBundles);
    return verify(subjectPath, bundlesPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function cryptographicallyVerify(
  subjectFile: Pick<PinnedFile, "bytes">,
  subject: TrustedRunSubject,
  detachedBundles?: Buffer,
): { sha256: string; version: string; detachedBundles: Buffer } {
  const signerSha = approvedSignerSha();
  if (subject.workflow.sha !== signerSha) {
    throw new Error("trusted publication signer revision is not the externally approved workflow SHA");
  }
  const verifier = pinnedVerifier();
  const result = withPinnedVerificationCopies(subjectFile.bytes, detachedBundles, (subjectPath, bundlesPath) =>
    spawnSync(GH_PATH, [
      "attestation", "verify", subjectPath,
      "--repo", subject.repository,
      "--signer-workflow", `${subject.repository}/${TRUSTED_WORKFLOW}`,
      "--signer-digest", signerSha,
      "--source-digest", signerSha,
      "--source-ref", "refs/heads/main",
      ...(bundlesPath ? ["--bundle", bundlesPath] : []),
      "--format", "json",
    ], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        ...(process.env.GITHUB_TOKEN ? { GH_TOKEN: process.env.GITHUB_TOKEN } : {}),
      },
      maxBuffer: 16 * 1024 * 1024,
    }));
  if (result.error || result.status !== 0) {
    throw new Error("trusted publication requires a valid GitHub OIDC detached attestation");
  }
  let output: unknown;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub attestation verifier returned invalid JSON");
  }
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error("GitHub attestation verifier returned no verified attestations");
  }
  const bundles = output.map((item) => {
    if (!item || typeof item !== "object" || !("attestation" in item)
      || !item.attestation || typeof item.attestation !== "object" || Array.isArray(item.attestation)) {
      throw new Error("GitHub attestation verifier omitted the detached attestation bundle");
    }
    return item.attestation;
  });
  return {
    ...verifier,
    detachedBundles: Buffer.from(`${bundles.map((bundle) => JSON.stringify(bundle)).join("\n")}\n`),
  };
}

type AttestationVerifier = (subjectFile: PinnedFile, subject: TrustedRunSubject) => {
  sha256: string;
  version: string;
  detachedBundles: Buffer;
};

/** Internal offline test seam. The package entrypoint exposes only
 * verifyHostedRunAttestation through bundle construction, which always uses
 * the fixed root-owned GitHub verifier above. */
export function verifyHostedRunAttestationWithVerifier(
  runRoot: string,
  verifierRuntime: AttestationVerifier,
): VerifiedHostedAttestation {
  const subjectRead = readCanonicalJson(
    runRoot,
    resolve(runRoot, "trusted-run-subject.json"),
    "trusted run attestation subject",
    (input) => TrustedRunSubjectSchema.parse(input),
  );
  const subject = subjectRead.value;
  const runtime = referencedCanonical(runRoot, subject.runtime.manifest, "trusted runtime manifest", (input) => RuntimeManifestSchema.parse(input));
  const configuration = referencedCanonical(runRoot, subject.configuration, "trusted batch configuration", (input) => ArenaBatchConfigurationSchema.parse(input));
  const batch = referencedCanonical(runRoot, subject.batch.manifest, "trusted batch manifest", (input) => ArenaBatchManifestSchema.parse(input));
  const completion = referencedCanonical(runRoot, subject.batch.completion, "trusted batch completion", (input) => ArenaBatchCompletionSchema.parse(input));
  if (configuration.value.execution?.runtime_backend !== "pinned-oci"
    || configuration.value.execution?.trust_level !== "hosted-trusted"
    || !configuration.value.sandbox
    || runtime.value.runtime_lock_sha256 !== subject.runtime.lock_sha256
    || runtime.value.tools_tree_sha256 !== subject.runtime.tools_tree_sha256
    || runtime.value.container.digest !== subject.runtime.container_digest
    || configuration.value.sandbox.runtime_lock_sha256 !== subject.runtime.lock_sha256
    || JSON.stringify(batch.value.configuration) !== JSON.stringify(configuration.value)
    || batch.value.source_commit_sha !== subject.source_commit_sha
    || batch.value.batch_id !== completion.value.batch_id
    || batch.value.source_commit_sha !== completion.value.source_commit_sha
    || batch.value.configuration_hash !== completion.value.configuration_hash
    || completion.value.runtime_manifest_sha256 !== sha256(runtime.file.bytes)
    || batch.value.batch_id !== subject.batch.id
    || batch.value.configuration_hash !== subject.batch.configuration_hash
    || completion.value.cells.length !== subject.batch.completed_cells) {
    throw new Error("trusted attestation subject does not match its sealed hosted runtime and batch");
  }
  const verifier = verifierRuntime(subjectRead.file, subject);
  const recheckedSubject = readPinnedFile(runRoot, subjectRead.file.path, "trusted run attestation subject");
  if (recheckedSubject.identity.dev !== subjectRead.file.identity.dev
    || recheckedSubject.identity.ino !== subjectRead.file.identity.ino
    || !recheckedSubject.bytes.equals(subjectRead.file.bytes)) {
    throw new Error("trusted run attestation subject changed during cryptographic verification");
  }
  return {
    subject,
    subjectFile: subjectRead.file,
    runtimeManifest: runtime.value,
    runtimeManifestFile: runtime.file,
    configuration: configuration.value,
    configurationFile: configuration.file,
    batch: batch.value,
    batchFile: batch.file,
    completion: completion.value,
    completionFile: completion.file,
    detachedBundles: verifier.detachedBundles,
    verification: {
      schema: "ax.github-oidc-attestation-verification/v1",
      repository: subject.repository,
      signer_workflow: `${subject.repository}/${TRUSTED_WORKFLOW}`,
      workflow_ref: subject.workflow.ref,
      workflow_sha: subject.workflow.sha,
      run_id: subject.workflow.run_id,
      run_attempt: subject.workflow.run_attempt,
    },
  };
}

export function verifyHostedRunAttestation(runRoot: string): VerifiedHostedAttestation {
  return verifyHostedRunAttestationWithVerifier(runRoot, cryptographicallyVerify);
}

export function verifyBundledHostedAttestation(
  subjectBytes: Buffer,
  detachedBundles: Buffer,
  subject: TrustedRunSubject,
): { sha256: string; version: string } {
  const result = cryptographicallyVerify({ bytes: subjectBytes }, subject, detachedBundles);
  return { sha256: result.sha256, version: result.version };
}
