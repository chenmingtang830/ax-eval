import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`trusted attestation requires ${name}`);
  return value;
};
const argument = (name) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`trusted attestation requires ${name} <value>`);
  return value;
};
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function fileReference(value, label) {
  const reference = object(value, label);
  exactKeys(reference, ["path", "sha256"], label);
  if (typeof reference.path !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) {
    throw new Error(`${label} reference is invalid`);
  }
  return reference;
}

function readRegular(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-linked regular file`);
  }
  return readFileSync(path);
}

function readCanonical(path, label) {
  const bytes = readRegular(path, label);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(canonicalBytes(value))) throw new Error(`${label} must use canonical JSON bytes`);
  return { bytes, value };
}

function relativeFile(root, path, label) {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)
    || basename(absolute) !== rel) {
    throw new Error(`${label} must be a direct child of the trusted run root`);
  }
  return rel.replaceAll("\\", "/");
}

function validateSubject(subject, root) {
  subject = object(subject, "trusted attestation subject");
  exactKeys(subject, [
    "schema", "repository", "source_commit_sha", "protected_default_branch",
    "workflow", "runtime", "configuration", "batch",
  ], "trusted attestation subject");
  const workflow = object(subject.workflow, "trusted workflow identity");
  const runtime = object(subject.runtime, "trusted runtime identity");
  const batchSubject = object(subject.batch, "trusted batch identity");
  exactKeys(workflow, ["ref", "sha", "run_id", "run_attempt", "environment"], "trusted workflow identity");
  exactKeys(runtime, ["lock_path", "lock_sha256", "container_digest", "tools_tree_sha256", "manifest"], "trusted runtime identity");
  exactKeys(batchSubject, ["id", "configuration_hash", "completed_cells", "manifest", "completion"], "trusted batch identity");
  const configurationReference = fileReference(subject.configuration, "batch configuration");
  const runtimeReference = fileReference(runtime.manifest, "runtime manifest");
  const batchReference = fileReference(batchSubject.manifest, "batch manifest");
  const completionReference = fileReference(batchSubject.completion, "batch completion");
  if (subject.schema !== "ax.arena-trusted-run-subject/v1"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subject.repository ?? "")
    || !/^[a-f0-9]{40}$/.test(subject.source_commit_sha ?? "")
    || subject.protected_default_branch !== "main"
    || typeof workflow.ref !== "string" || !/\S/.test(workflow.ref) || /[\u0000-\u001f\u007f]/.test(workflow.ref)
    || !/^[a-f0-9]{40}$/.test(workflow.sha ?? "")
    || !/^\d+$/.test(workflow.run_id ?? "") || !/^[1-9]\d*$/.test(workflow.run_attempt ?? "")
    || workflow.environment !== "trusted-sandbox"
    || runtime.lock_path !== "ax-arena/benchmark/trusted-runtime/runtime-lock.json"
    || !/^[a-f0-9]{64}$/.test(runtime.lock_sha256 ?? "")
    || !/^sha256:[a-f0-9]{64}$/.test(runtime.container_digest ?? "")
    || !/^[a-f0-9]{64}$/.test(runtime.tools_tree_sha256 ?? "")
    || typeof batchSubject.id !== "string" || !/\S/.test(batchSubject.id)
    || !/^[a-f0-9]{64}$/.test(batchSubject.configuration_hash ?? "")
    || !Number.isSafeInteger(batchSubject.completed_cells) || batchSubject.completed_cells < 1) {
    throw new Error("trusted attestation subject has an invalid contract");
  }
  const checked = [];
  for (const [entry, label] of [
    [runtimeReference, "runtime manifest"],
    [configurationReference, "batch configuration"],
    [batchReference, "batch manifest"],
    [completionReference, "batch completion"],
  ]) {
    const path = resolve(root, entry.path);
    if (relativeFile(root, path, label) !== entry.path || sha256(readRegular(path, label)) !== entry.sha256) {
      throw new Error(`${label} does not match its detached attestation hash`);
    }
    checked.push(path);
  }
  const runtimeManifest = readCanonical(checked[0], "runtime manifest").value;
  const configuration = readCanonical(checked[1], "batch configuration").value;
  const batch = readCanonical(checked[2], "batch manifest").value;
  const completion = readCanonical(checked[3], "batch completion").value;
  if (runtimeManifest.runtime_lock_sha256 !== subject.runtime.lock_sha256
    || runtimeManifest.tools_tree_sha256 !== subject.runtime.tools_tree_sha256
    || runtimeManifest.container?.digest !== subject.runtime.container_digest
    || configuration.sandbox?.runtime_lock_sha256 !== subject.runtime.lock_sha256
    || configuration.execution?.runtime_backend !== "pinned-oci"
    || configuration.execution?.trust_level !== "hosted-trusted"
    || JSON.stringify(batch.configuration) !== JSON.stringify(configuration)
    || batch.source_commit_sha !== subject.source_commit_sha
    || batch.batch_id !== completion.batch_id
    || batch.source_commit_sha !== completion.source_commit_sha
    || batch.configuration_hash !== completion.configuration_hash
    || batch.batch_id !== subject.batch.id
    || batch.configuration_hash !== subject.batch.configuration_hash
    || completion.cells?.length !== subject.batch.completed_cells) {
    throw new Error("trusted attestation subject does not match its sealed runtime and batch");
  }
  return subject;
}

if (process.argv.includes("--verify")) {
  const requestedSubjectPath = resolve(argument("--verify"));
  const root = realpathSync(dirname(requestedSubjectPath));
  const subjectPath = resolve(root, basename(requestedSubjectPath));
  const subject = readCanonical(subjectPath, "trusted attestation subject").value;
  validateSubject(subject, root);
  for (const [environmentName, actual, label] of [
    ["GITHUB_REPOSITORY", subject.repository, "repository"],
    ["AX_ARENA_SOURCE_SHA", subject.source_commit_sha, "source SHA"],
    ["PROTECTED_DEFAULT_BRANCH", subject.protected_default_branch, "protected branch"],
    ["GITHUB_WORKFLOW_REF", subject.workflow.ref, "workflow ref"],
    ["GITHUB_WORKFLOW_SHA", subject.workflow.sha, "workflow SHA"],
    ["GITHUB_RUN_ID", subject.workflow.run_id, "workflow run ID"],
    ["GITHUB_RUN_ATTEMPT", subject.workflow.run_attempt, "workflow run attempt"],
  ]) {
    if (process.env[environmentName] && actual !== process.env[environmentName]) {
      throw new Error(`trusted attestation ${label} does not match the signing workflow`);
    }
  }
  process.stdout.write(`${sha256(readFileSync(subjectPath))}  ${subjectPath}\n`);
  process.exit(0);
}

const runRoot = realpathSync(resolve(argument("--run-root")));
const requestedOutputPath = resolve(argument("--out"));
const outputPath = resolve(realpathSync(dirname(requestedOutputPath)), basename(requestedOutputPath));
relativeFile(runRoot, outputPath, "trusted attestation subject");
const runtimeManifestPath = resolve(runRoot, argument("--runtime-manifest"));
const configurationPath = resolve(runRoot, argument("--configuration"));
const batchPath = resolve(runRoot, "batch.json");
const completionPath = resolve(runRoot, "batch-completion.json");
const runtimeManifest = readCanonical(runtimeManifestPath, "runtime manifest");
const configuration = readCanonical(configurationPath, "batch configuration");
const batch = readCanonical(batchPath, "batch manifest");
const completion = readCanonical(completionPath, "batch completion");
const sourceSha = required("AX_ARENA_SOURCE_SHA");
if (batch.value.source_commit_sha !== sourceSha || completion.value.source_commit_sha !== sourceSha) {
  throw new Error("trusted attestation source SHA does not match the sealed batch");
}
const subject = {
  schema: "ax.arena-trusted-run-subject/v1",
  repository: required("GITHUB_REPOSITORY"),
  source_commit_sha: sourceSha,
  protected_default_branch: required("PROTECTED_DEFAULT_BRANCH"),
  workflow: {
    ref: required("GITHUB_WORKFLOW_REF"),
    sha: required("GITHUB_WORKFLOW_SHA"),
    run_id: required("GITHUB_RUN_ID"),
    run_attempt: required("GITHUB_RUN_ATTEMPT"),
    environment: "trusted-sandbox",
  },
  runtime: {
    lock_path: runtimeManifest.value.runtime_lock_path,
    lock_sha256: runtimeManifest.value.runtime_lock_sha256,
    container_digest: runtimeManifest.value.container?.digest,
    tools_tree_sha256: runtimeManifest.value.tools_tree_sha256,
    manifest: {
      path: relativeFile(runRoot, runtimeManifestPath, "runtime manifest"),
      sha256: sha256(runtimeManifest.bytes),
    },
  },
  configuration: {
    path: relativeFile(runRoot, configurationPath, "batch configuration"),
    sha256: sha256(configuration.bytes),
  },
  batch: {
    id: batch.value.batch_id,
    configuration_hash: batch.value.configuration_hash,
    completed_cells: completion.value.cells?.length,
    manifest: { path: relativeFile(runRoot, batchPath, "batch manifest"), sha256: sha256(batch.bytes) },
    completion: { path: relativeFile(runRoot, completionPath, "batch completion"), sha256: sha256(completion.bytes) },
  },
};
validateSubject(subject, runRoot);
const descriptor = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
try {
  writeFileSync(descriptor, canonicalBytes(subject));
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
process.stdout.write(`${sha256(readFileSync(outputPath))}  ${outputPath}\n`);
