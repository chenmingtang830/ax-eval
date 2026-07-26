import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const RUNTIME_LOCK_PATH = "ax-arena/benchmark/trusted-runtime/runtime-lock.json";
export const TRUSTED_HARNESS_PACKAGE_PATH = "ax-arena/benchmark/trusted-runtime/harness/package.json";
export const TRUSTED_HARNESS_LOCK_PATH = "ax-arena/benchmark/trusted-runtime/harness/package-lock.json";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path));
}

export function readRegularBytes(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-linked regular file`);
  }
  return readFileSync(path);
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

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function httpsVersionedUrl(value, label) {
  const url = exactString(value, /^https:\/\//, label);
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.some((segment) => /^(?:latest|master)$/i.test(segment))
    || /\/(?:releases|archive|refs\/heads)\/main(?:\/|$)/i.test(parsed.pathname)
    || /^main$/i.test(segments.at(0) ?? "")) {
    throw new Error(`${label} must not use a mutable release alias`);
  }
  return url;
}

function validateHarnessPin(value, expectedPackage, label) {
  const pin = object(value, label);
  exactKeys(pin, ["package", "version", "version_output", "executable_path"], label);
  if (pin.package !== expectedPackage) throw new Error(`${label} package identity is invalid`);
  exactString(pin.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${label} version`);
  exactString(pin.version_output, /^\S.{0,255}$/, `${label} version output`);
  exactString(pin.executable_path, /^\/opt\/ax-arena-tools\/harness\//, `${label} executable path`);
  return pin;
}

export function parseRuntimeLock(input) {
  const lock = object(input, "trusted runtime lock");
  exactKeys(lock, ["schema", "platform", "container", "harnesses", "bubblewrap", "turso_cli"], "trusted runtime lock");
  if (lock.schema !== "ax.arena-trusted-runtime-lock/v1" || lock.platform !== "linux/amd64") {
    throw new Error("trusted runtime lock schema or platform is unsupported");
  }

  const container = object(lock.container, "runtime container");
  exactKeys(container, ["image", "digest", "node_version"], "runtime container");
  exactString(container.image, /^docker\.io\/library\/node:\d+\.\d+\.\d+-bookworm$/, "runtime container image");
  exactString(container.digest, /^sha256:[a-f0-9]{64}$/, "runtime container digest");
  exactString(container.node_version, /^22\.\d+\.\d+$/, "runtime Node version");
  if (!container.image.includes(`node:${container.node_version}-`)) {
    throw new Error("runtime Node version does not match the image tag");
  }

  const harnesses = object(lock.harnesses, "harness runtime");
  exactKeys(harnesses, ["package_lock_path", "package_lock_sha256", "codex", "claude_code"], "harness runtime");
  if (harnesses.package_lock_path !== TRUSTED_HARNESS_LOCK_PATH) {
    throw new Error("harness runtime must use the canonical package lock");
  }
  exactString(harnesses.package_lock_sha256, /^[a-f0-9]{64}$/, "harness package-lock hash");
  validateHarnessPin(harnesses.codex, "@openai/codex", "Codex pin");
  validateHarnessPin(harnesses.claude_code, "@anthropic-ai/claude-code", "Claude Code pin");

  const bubblewrap = object(lock.bubblewrap, "bubblewrap pin");
  exactKeys(bubblewrap, ["version", "archive_url", "archive_sha256", "executable_path", "executable_sha256"], "bubblewrap pin");
  exactString(bubblewrap.version, /^\d+\.\d+\.\d+-[^\s]+$/, "bubblewrap version");
  httpsVersionedUrl(bubblewrap.archive_url, "bubblewrap archive URL");
  exactString(bubblewrap.archive_sha256, /^[a-f0-9]{64}$/, "bubblewrap archive hash");
  if (bubblewrap.executable_path !== "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap") {
    throw new Error("bubblewrap executable path is not canonical");
  }
  exactString(bubblewrap.executable_sha256, /^[a-f0-9]{64}$/, "bubblewrap executable hash");

  const turso = object(lock.turso_cli, "Turso CLI pin");
  exactKeys(turso, ["version", "version_output", "archive_url", "archive_sha256", "executable_path", "executable_sha256"], "Turso CLI pin");
  exactString(turso.version, /^\d+\.\d+\.\d+$/, "Turso CLI version");
  exactString(turso.version_output, /^turso version v\d+\.\d+\.\d+$/, "Turso CLI version output");
  httpsVersionedUrl(turso.archive_url, "Turso CLI archive URL");
  exactString(turso.archive_sha256, /^[a-f0-9]{64}$/, "Turso CLI archive hash");
  if (turso.executable_path !== "/opt/ax-arena-tools/turso/bin/turso") {
    throw new Error("Turso CLI executable path is not canonical");
  }
  exactString(turso.executable_sha256, /^[a-f0-9]{64}$/, "Turso CLI executable hash");
  return lock;
}

function validatePackageLock(root, runtimeLock) {
  const lockPath = resolve(root, TRUSTED_HARNESS_LOCK_PATH);
  const bytes = readRegularBytes(lockPath, "trusted harness package lock");
  if (sha256(bytes) !== runtimeLock.harnesses.package_lock_sha256) {
    throw new Error("trusted harness package lock hash does not match the runtime lock");
  }
  const packageLock = JSON.parse(bytes.toString("utf8"));
  if (packageLock.lockfileVersion !== 3 || packageLock.requires !== true) {
    throw new Error("trusted harness package lock must use npm lockfile v3");
  }
  const packages = object(packageLock.packages, "trusted harness package closure");
  const rootPackage = object(packages[""], "trusted harness root package");
  const expected = {
    "@openai/codex": runtimeLock.harnesses.codex.version,
    "@anthropic-ai/claude-code": runtimeLock.harnesses.claude_code.version,
  };
  if (JSON.stringify(rootPackage.dependencies) !== JSON.stringify({
    "@anthropic-ai/claude-code": expected["@anthropic-ai/claude-code"],
    "@openai/codex": expected["@openai/codex"],
  })) throw new Error("trusted harness root dependencies do not match the runtime lock");
  for (const [name, version] of Object.entries(expected)) {
    const entry = object(packages[`node_modules/${name}`], `${name} package lock entry`);
    if (entry.version !== version || typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new Error(`${name} package lock entry does not match the exact runtime pin`);
    }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`${name} must resolve from the canonical npm registry`);
    }
  }
  for (const path of [
    "node_modules/@openai/codex-linux-x64",
    "node_modules/@anthropic-ai/claude-code-linux-x64",
  ]) {
    const entry = object(packages[path], `${path} package lock entry`);
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")
      || !Array.isArray(entry.os) || !entry.os.includes("linux")
      || !Array.isArray(entry.cpu) || !entry.cpu.includes("x64")) {
      throw new Error(`${path} is not an integrity-pinned linux/x64 artifact`);
    }
  }
  return { bytes, packageLock };
}

export function readTrustedRuntime(root) {
  const canonicalRoot = realpathSync(root);
  const lockPath = resolve(canonicalRoot, RUNTIME_LOCK_PATH);
  if (!isInside(canonicalRoot, lockPath)) throw new Error("trusted runtime lock escaped the repository");
  const bytes = readRegularBytes(lockPath, "trusted runtime lock");
  const lock = parseRuntimeLock(JSON.parse(bytes.toString("utf8")));
  const harness = validatePackageLock(canonicalRoot, lock);
  return {
    root: canonicalRoot,
    lockPath,
    lock,
    bytes,
    sha256: sha256(bytes),
    harnessLockBytes: harness.bytes,
  };
}

export function assertCanonicalPath(root, path, label) {
  const absolute = resolve(root, path);
  if (!isInside(root, absolute) || realpathSync(dirname(absolute)) !== dirname(absolute)) {
    throw new Error(`${label} must stay inside a canonical repository directory`);
  }
  return absolute;
}
