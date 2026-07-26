import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`trusted export requires ${name} <value>`);
  return value;
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

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

function readRegular(path, label) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`${label} must be a single-linked regular file`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseCanonicalBytes(bytes, label) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(canonicalBytes(value))) throw new Error(`${label} must use canonical JSON bytes`);
  return { bytes, value };
}

function readCanonical(path, label) {
  return parseCanonicalBytes(readRegular(path, label), label);
}

function trustedPath(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) {
    throw new Error(`${label} path must be relative to the trusted run root`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} path is not canonical`);
  }
  const absolute = resolve(root, path);
  if (!inside(root, absolute) || realpathSync(dirname(absolute)) !== dirname(absolute)) {
    throw new Error(`${label} path escaped or traversed a symlink`);
  }
  return absolute;
}

function reference(value, expectedPath, label) {
  const entry = object(value, label);
  exactKeys(entry, ["path", "sha256"], label);
  if (entry.path !== expectedPath || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
    throw new Error(`${label} reference is invalid`);
  }
  return entry;
}

function writeExclusive(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularTree(root, current = root) {
  for (const name of readdirSync(current)) {
    const path = resolve(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`trusted export contains a symlink: ${relative(root, path)}`);
    if (stat.isDirectory()) assertRegularTree(root, path);
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`trusted export contains an unsupported file: ${relative(root, path)}`);
  }
}

const runRoot = realpathSync(resolve(argument("--run-root")));
const output = resolve(argument("--out"));
const outputParent = realpathSync(dirname(output));
const canonicalOutput = resolve(outputParent, basename(output));
if (inside(runRoot, canonicalOutput) || inside(canonicalOutput, runRoot) || canonicalOutput === runRoot) {
  throw new Error("trusted export must live outside the harness-writable run root");
}
mkdirSync(canonicalOutput, { mode: 0o700 });

const subjectFile = readCanonical(trustedPath(runRoot, "trusted-run-subject.json", "trusted attestation subject"), "trusted attestation subject");
const subject = object(subjectFile.value, "trusted attestation subject");
if (subject.schema !== "ax.arena-trusted-run-subject/v1") throw new Error("trusted attestation subject schema is invalid");
const runtimeSubject = object(subject.runtime, "trusted runtime identity");
const batchSubject = object(subject.batch, "trusted batch identity");
const configurationReference = reference(subject.configuration, "configuration.json", "batch configuration");
const runtimeReference = reference(runtimeSubject.manifest, "runtime-manifest.json", "runtime manifest");
const batchReference = reference(batchSubject.manifest, "batch.json", "batch manifest");
const completionReference = reference(batchSubject.completion, "batch-completion.json", "batch completion");

const entries = new Map();
function add(path, expectedHash, label) {
  if (entries.has(path)) throw new Error(`trusted export path is duplicated: ${path}`);
  const bytes = readRegular(trustedPath(runRoot, path, label), label);
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error(`${label} does not match its sealed SHA-256`);
  entries.set(path, bytes);
}

add("trusted-run-subject.json", sha256(subjectFile.bytes), "trusted attestation subject");
add(configurationReference.path, configurationReference.sha256, "batch configuration");
add(runtimeReference.path, runtimeReference.sha256, "runtime manifest");
add(batchReference.path, batchReference.sha256, "batch manifest");
add(completionReference.path, completionReference.sha256, "batch completion");

const batch = parseCanonicalBytes(entries.get(batchReference.path), "batch manifest").value;
const completion = parseCanonicalBytes(entries.get(completionReference.path), "batch completion").value;
if (batch?.schema !== "ax.arena-batch/v1" || completion?.schema !== "ax.arena-batch-completion/v1"
  || batch.batch_id !== completion.batch_id || batch.batch_id !== batchSubject.id
  || batch.source_commit_sha !== completion.source_commit_sha || batch.source_commit_sha !== subject.source_commit_sha
  || batch.configuration_hash !== completion.configuration_hash
  || batch.configuration_hash !== batchSubject.configuration_hash
  || !Array.isArray(completion.cells) || completion.cells.length !== batchSubject.completed_cells) {
  throw new Error("trusted export batch identity is inconsistent");
}

const artifactNames = ["invoke_metadata", "results", "trace", "transcript"];
for (const [index, cellValue] of completion.cells.entries()) {
  const cell = object(cellValue, `completion cell ${index + 1}`);
  if (typeof cell.record_path !== "string" || !/^[a-f0-9]{64}$/.test(cell.record_hash ?? "")
    || typeof cell.cleanup_path !== "string" || !/^[a-f0-9]{64}$/.test(cell.cleanup_hash ?? "")
    || !Array.isArray(cell.artifacts) || cell.artifacts.length !== artifactNames.length) {
    throw new Error(`completion cell ${index + 1} has invalid sealed paths`);
  }
  add(cell.record_path, cell.record_hash, `completion cell ${index + 1} record`);
  add(cell.cleanup_path, cell.cleanup_hash, `completion cell ${index + 1} cleanup`);
  for (const [artifactIndex, artifactValue] of cell.artifacts.entries()) {
    const artifact = object(artifactValue, `completion cell ${index + 1} artifact ${artifactIndex + 1}`);
    exactKeys(artifact, ["name", "path", "sha256"], `completion cell ${index + 1} artifact ${artifactIndex + 1}`);
    if (artifact.name !== artifactNames[artifactIndex] || typeof artifact.path !== "string"
      || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error(`completion cell ${index + 1} artifact seals are invalid`);
    }
    add(artifact.path, artifact.sha256, `completion cell ${index + 1} ${artifact.name}`);
  }
}

for (const [path, bytes] of entries) writeExclusive(resolve(canonicalOutput, path), bytes);
assertRegularTree(canonicalOutput);
process.stdout.write(`${JSON.stringify({ output: canonicalOutput, files: entries.size })}\n`);
