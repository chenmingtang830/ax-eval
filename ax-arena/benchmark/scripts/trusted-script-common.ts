import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_COMMITTED_FILE_BYTES = 16 * 1024 * 1024;
const GIT_PATH = "/usr/bin/git";
const TRUSTED_TOOL_ROOT = "/opt/ax-arena-tools";
const TRUSTED_SYSROOT = "/opt/ax-arena-runtime/rootfs";
const TRUSTED_NODE_PATH = `${TRUSTED_TOOL_ROOT}/node/bin/node`;
const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/var/empty",
  USER: process.env.USER ?? "root",
  LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "root",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_PAGER: "cat",
} as const;

function assertPinnedGit(): void {
  const stat = lstatSync(GIT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
    || realpathSync(GIT_PATH) !== GIT_PATH) {
    throw new Error("trusted arena source verification requires root-owned, non-writable /usr/bin/git");
  }
}

function git(args: readonly string[], cwd?: string, encoding: "utf8" | "buffer" = "utf8"): string | Buffer {
  assertPinnedGit();
  return execFileSync(GIT_PATH, [...args], {
    ...(cwd ? { cwd } : {}),
    encoding,
    env: GIT_ENV,
    maxBuffer: MAX_COMMITTED_FILE_BYTES + 1,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readPinned(path: string, label: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_COMMITTED_FILE_BYTES) {
      throw new Error(`${label} must be a bounded single-linked regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_COMMITTED_FILE_BYTES + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > MAX_COMMITTED_FILE_BYTES) throw new Error(`${label} exceeds the 16 MiB input limit`);
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
      || current.dev !== after.dev || current.ino !== after.ino || total !== before.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
  return object;
}

function trustedTreeEntries(root: string, current = root, entries: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  for (const name of readdirSync(current).sort()) {
    const path = resolve(current, name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const stat = lstatSync(path);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
      throw new Error(`trusted runtime entry ${relativePath} must be root-owned and non-writable`);
    }
    if (stat.isDirectory()) {
      entries.push({ path: `${relativePath}/`, type: "directory", mode: stat.mode & 0o777 });
      trustedTreeEntries(root, path, entries);
    } else if (stat.isFile()) {
      const bytes = readPinned(path, `trusted runtime entry ${relativePath}`);
      entries.push({
        path: relativePath,
        type: "file",
        mode: stat.mode & 0o777,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = resolve(dirname(path), target);
      if (isAbsolute(target) || !isInside(root, resolvedTarget)) {
        throw new Error(`trusted runtime symlink ${relativePath} must remain inside its immutable tool tree`);
      }
      entries.push({ path: relativePath, type: "symlink", target });
    } else {
      throw new Error(`trusted runtime entry ${relativePath} has an unsupported file type`);
    }
  }
  return entries;
}

function assertRootOwnedPath(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must be root-owned, non-writable, and cannot be a symlink`);
  }
}

export interface TrustedRuntimeIdentity {
  sha256: string;
  lock: {
    platform?: string;
    container: { image: string; digest: string; node_version: string };
  };
}

export interface VerifiedRuntimeManifest {
  bytes: Buffer;
  sha256: string;
  nodeExecutableSha256: string;
  trustedPath: string;
}

export function assertTrustedRuntimeManifest(
  runRoot: string,
  suppliedPath: string,
  runtime: TrustedRuntimeIdentity,
): VerifiedRuntimeManifest {
  assertCanonicalRunArtifact(runRoot, suppliedPath, "runtime-manifest.json", "trusted runtime manifest");
  const path = resolve(suppliedPath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o222) !== 0
    || realpathSync(path) !== path) {
    throw new Error("trusted runtime manifest must be a root-owned, read-only, single-linked regular file");
  }
  const bytes = readPinned(path, "trusted runtime manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("trusted runtime manifest must be valid JSON");
  }
  const manifest = exactObject(parsed, [
    "schema",
    "platform",
    "runtime_lock_path",
    "runtime_lock_sha256",
    "sysroot",
    "container",
    "node_executable_sha256",
    "tools_tree_sha256",
    "entries",
  ], "trusted runtime manifest");
  const container = exactObject(manifest.container, ["image", "digest", "node_version"], "trusted runtime container");
  if (manifest.schema !== "ax.arena-trusted-runtime-manifest/v1"
    || manifest.platform !== "linux/amd64"
    || manifest.runtime_lock_path !== "ax-arena/benchmark/trusted-runtime/runtime-lock.json"
    || manifest.runtime_lock_sha256 !== runtime.sha256
    || manifest.sysroot !== TRUSTED_SYSROOT
    || JSON.stringify(container) !== JSON.stringify(runtime.lock.container)
    || typeof manifest.node_executable_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.node_executable_sha256)
    || typeof manifest.tools_tree_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.tools_tree_sha256)
    || !Array.isArray(manifest.entries)) {
    throw new Error("trusted runtime manifest does not match the immutable runtime lock");
  }

  for (const immutablePath of [
    "/opt/ax-arena-runtime",
    TRUSTED_SYSROOT,
    `${TRUSTED_SYSROOT}/usr`,
    `${TRUSTED_SYSROOT}/usr/local`,
    `${TRUSTED_SYSROOT}/usr/local/bin`,
    `${TRUSTED_SYSROOT}/usr/local/bin/node`,
    TRUSTED_TOOL_ROOT,
    `${TRUSTED_TOOL_ROOT}/node`,
    `${TRUSTED_TOOL_ROOT}/node/bin`,
    TRUSTED_NODE_PATH,
  ]) assertRootOwnedPath(immutablePath, `trusted runtime path ${immutablePath}`);
  if (realpathSync(TRUSTED_SYSROOT) !== TRUSTED_SYSROOT
    || realpathSync(TRUSTED_NODE_PATH) !== TRUSTED_NODE_PATH
    || realpathSync(process.execPath) !== TRUSTED_NODE_PATH) {
    throw new Error("trusted worker must execute the exact Node binary copied from the immutable OCI sysroot");
  }
  const sysrootNodeBytes = readPinned(`${TRUSTED_SYSROOT}/usr/local/bin/node`, "trusted OCI sysroot Node");
  const workerNodeBytes = readPinned(TRUSTED_NODE_PATH, "trusted worker Node");
  const nodeHash = createHash("sha256").update(workerNodeBytes).digest("hex");
  if (!workerNodeBytes.equals(sysrootNodeBytes) || nodeHash !== manifest.node_executable_sha256) {
    throw new Error("trusted worker Node does not match the runtime manifest and immutable OCI sysroot");
  }
  const actualEntries = trustedTreeEntries(TRUSTED_TOOL_ROOT);
  const actualTreeHash = createHash("sha256").update(JSON.stringify(actualEntries)).digest("hex");
  if (JSON.stringify(actualEntries) !== JSON.stringify(manifest.entries)
    || actualTreeHash !== manifest.tools_tree_sha256) {
    throw new Error("trusted tool tree does not match the root-owned runtime manifest");
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nodeExecutableSha256: nodeHash,
    trustedPath: `${TRUSTED_TOOL_ROOT}/turso/bin:${TRUSTED_TOOL_ROOT}/harness/node_modules/.bin:${TRUSTED_TOOL_ROOT}/node/bin:/usr/bin:/bin`,
  };
}

export function parseFlags(allowed: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  const allowedSet = new Set(allowed);
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !allowedSet.has(name)) {
      throw new Error(`unknown trusted arena flag ${name ?? ""}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`trusted arena flag ${name} requires a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

export function oneFlag(values: ReadonlyMap<string, readonly string[]>, name: string): string {
  const found = values.get(name) ?? [];
  if (found.length !== 1) throw new Error(`trusted arena entrypoint requires exactly one ${name} <value>`);
  return found[0]!;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`trusted arena entrypoint requires ${name}`);
  return value;
}

function harnessSemver(raw: string): string | undefined {
  return raw.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function assertHarnessVersionOutput(raw: string, expectedRaw: string, expectedSemver: string): void {
  const trimmed = raw.trim();
  if (trimmed !== expectedRaw || harnessSemver(trimmed) !== expectedSemver) {
    throw new Error("installed harness version does not match the immutable cell descriptor");
  }
}

function assertRootOwnedImmutable(path: string, label: string, allowSymlink = false): void {
  const stat = lstatSync(path);
  if ((!allowSymlink && stat.isSymbolicLink()) || stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
    throw new Error(`${label} must be root-owned and non-writable`);
  }
}

export function attestTrustedHarnessBinary(input: {
  command: string;
  trustedInstallRoot: string;
  searchPath: string;
  expectedRaw: string;
  expectedSemver: string;
  probe: { command: string; args: readonly string[]; cwd: string };
}): void {
  const installRoot = realpathSync(resolve(input.trustedInstallRoot));
  const command = resolve(input.command);
  const commandRelative = relative(installRoot, command);
  if (commandRelative === ".." || commandRelative.startsWith("../")
    || commandRelative.startsWith("..\\") || isAbsolute(commandRelative)) {
    throw new Error("trusted harness launcher must live inside its immutable install root");
  }
  const commandStat = lstatSync(command);
  assertRootOwnedImmutable(command, "trusted harness launcher", commandStat.isSymbolicLink());
  let lexicalParent = dirname(command);
  for (;;) {
    assertRootOwnedImmutable(lexicalParent, "trusted harness launcher path");
    if (lexicalParent === installRoot) break;
    const parent = dirname(lexicalParent);
    if (parent === lexicalParent) throw new Error("trusted harness launcher escaped its install root");
    lexicalParent = parent;
  }
  const binary = realpathSync(command);
  const rel = relative(installRoot, binary);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error("trusted harness binary must resolve inside its immutable install root");
  }
  let current = binary;
  for (;;) {
    assertRootOwnedImmutable(current, "trusted harness path");
    if (current === installRoot) break;
    const parent = dirname(current);
    if (parent === current) throw new Error("trusted harness path escaped its install root");
    current = parent;
  }
  const result = spawnSync(input.probe.command, input.probe.args, {
    cwd: input.probe.cwd,
    encoding: "utf8",
    env: { PATH: input.searchPath },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || "trusted harness version probe failed");
  }
  assertHarnessVersionOutput(result.stdout.trim() || result.stderr.trim(), input.expectedRaw, input.expectedSemver);
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

export function repositoryRoot(): string {
  return realpathSync((git(["rev-parse", "--show-toplevel"]) as string).trim());
}

export function assertSourceHead(root: string, sourceSha: string): void {
  const head = (git(["rev-parse", "HEAD"], root) as string).trim();
  if (sourceSha !== head || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error("trusted arena source SHA must be the full checked-out commit ID");
  }
  if ((git(["cat-file", "-t", sourceSha], root) as string).trim() !== "commit") {
    throw new Error("trusted arena source SHA must identify a commit object");
  }
}

export function assertNoSymlinkChain(root: string, path: string, label: string): void {
  const absolute = resolve(path);
  if (!isInside(root, absolute)) throw new Error(`${label} must resolve inside the repository`);
  let current = root;
  for (const segment of relative(root, absolute).split(/[\\/]/)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function assertCommittedFile(root: string, sourceSha: string, path: string, label: string): Buffer {
  const absolute = resolve(path);
  assertNoSymlinkChain(root, absolute, label);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a committed single-linked regular file`);
  if (stat.size > MAX_COMMITTED_FILE_BYTES) throw new Error(`${label} exceeds the 16 MiB input limit`);
  const bytes = readPinned(absolute, label);
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  const treeEntry = git(["ls-tree", "-z", "--full-tree", sourceSha, "--", relativePath], root, "buffer") as Buffer;
  const parsed = treeEntry.toString("utf8").match(/^100(?:644|755) blob [a-f0-9]+\t/);
  if (!parsed || treeEntry.filter((byte) => byte === 0).length !== 1) {
    throw new Error(`${label} is absent or is not a regular blob at the immutable source commit`);
  }
  const committed = git(["show", `${sourceSha}:${relativePath}`], root, "buffer") as Buffer;
  if (!bytes.equals(committed)) throw new Error(`${label} bytes must match the immutable source commit`);
  return bytes;
}

export function assertCommittedConfigurationSource(
  root: string,
  sourceSha: string,
  source: { path: string; file_hash: string } | undefined,
): Buffer {
  if (!source) throw new Error("trusted arena batch requires a committed configuration source attestation");
  const bytes = assertCommittedFile(root, sourceSha, resolve(root, source.path), "batch configuration source");
  if (createHash("sha256").update(bytes).digest("hex") !== source.file_hash) {
    throw new Error("batch configuration source hash does not match the immutable manifest");
  }
  return bytes;
}

export function assertExpectedConfigurationSource(
  source: { path: string; file_hash: string } | undefined,
  expectedPath: string,
  expectedHash: string,
): void {
  if (!source || source.path !== expectedPath || source.file_hash !== expectedHash
    || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("batch configuration source does not match the external controller attestation");
  }
}

export function assertCanonicalRunArtifact(
  runRoot: string,
  suppliedPath: string,
  filename: string,
  label: string,
): void {
  if (resolve(suppliedPath) !== resolve(runRoot, filename)) {
    throw new Error(`${label} must be ${resolve(runRoot, filename)}`);
  }
}
