import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 16_384;

export interface PinnedFile {
  path: string;
  bytes: Buffer;
  identity: { dev: number; ino: number };
}

export interface PlannedPublicationFile {
  path: string;
  bytes: Buffer;
}

function isEscape(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

export function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || !isEscape(path);
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

export function canonicalRoot(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return realpathSync(absolute);
}

export function resolveContained(root: string, input: string, label: string, allowRoot = false): string {
  const absolute = resolve(root, input);
  const lexical = relative(root, absolute);
  if ((!allowRoot && lexical === "") || isEscape(lexical)) {
    throw new Error(`${label} must resolve inside the repository root`);
  }
  return absolute;
}

export function assertNoSymlinkChain(root: string, path: string, label: string, allowMissing = false): void {
  const lexical = relative(root, path);
  if (isEscape(lexical)) throw new Error(`${label} escapes its trusted root`);
  let current = root;
  for (const segment of lexical.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      if (allowMissing) return;
      throw new Error(`${label} does not exist`);
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
  }
}

export function readPinnedFile(
  root: string,
  input: string,
  label: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): PinnedFile {
  const path = resolveContained(root, input, label);
  assertNoSymlinkChain(root, path, label);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(opened.size > maxBytes ? `${label} exceeds the ${maxBytes} byte limit` : `${label} must be a regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
    const after = fstatSync(descriptor);
    assertNoSymlinkChain(root, path, label);
    const current = lstatSync(path);
    const metadataChanged = after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs
      || current.ctimeMs !== opened.ctimeMs;
    if (!after.isFile() || !sameIdentity(opened, after) || metadataChanged
      || total !== opened.size || !current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw new Error(`${label} changed during validation`);
    }
    const realRoot = realpathSync(root);
    const physical = realpathSync(path);
    if (!insideOrEqual(realRoot, physical) || physical === realRoot) throw new Error(`${label} escaped its physical root`);
    return {
      path,
      bytes: Buffer.concat(chunks, total),
      identity: { dev: Number(opened.dev), ino: Number(opened.ino) },
    };
  } finally {
    closeSync(descriptor);
  }
}

export function readCanonicalJson<T>(
  root: string,
  input: string,
  label: string,
  parse: (input: unknown) => T,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): { file: PinnedFile; value: T } {
  const file = readPinnedFile(root, input, label, maxBytes);
  return { file, value: parseCanonicalJsonFile(file, label, parse) };
}

export function parseCanonicalJsonFile<T>(
  file: PinnedFile,
  label: string,
  parse: (input: unknown) => T,
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!file.bytes.equals(Buffer.from(`${JSON.stringify(decoded, null, 2)}\n`))) {
    throw new Error(`${label} is not in canonical persisted form`);
  }
  return parse(decoded);
}

function canonicalRelative(path: string, label: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path === "." || posix.normalize(path) !== path || path.startsWith("../")) {
    throw new Error(`${label} must be a canonical contained relative path`);
  }
  return path;
}

function ensureDirectory(root: string, relativePath: string): string {
  let current = root;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`publication output parent is unsafe: ${current}`);
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

export function writeAtomicDirectory(
  repositoryRoot: string,
  outDir: string,
  files: readonly PlannedPublicationFile[],
  sourceRoots: readonly string[] = [],
  validate?: (stagingRoot: string) => void,
): string {
  const root = canonicalRoot(repositoryRoot, "publication repository root");
  const output = resolveContained(root, outDir, "publication output");
  if (existsSync(output)) throw new Error("publication output must not already exist");
  for (const sourceRoot of sourceRoots) {
    const source = resolve(sourceRoot);
    if (insideOrEqual(source, output) || insideOrEqual(output, source)) {
      throw new Error("publication output must not overlap an input root");
    }
  }
  if (files.length === 0 || files.length > MAX_OUTPUT_FILES) throw new Error("publication output file count is invalid");
  const paths = files.map((file) => canonicalRelative(file.path, "publication output file"));
  if (new Set(paths).size !== paths.length) throw new Error("publication output files must be unique");

  const parent = dirname(output);
  const parentRelative = relative(root, parent).replaceAll("\\", "/");
  ensureDirectory(root, parentRelative === "." ? "" : parentRelative);
  assertNoSymlinkChain(root, parent, "publication output parent");
  const realParent = realpathSync(parent);
  if (!insideOrEqual(root, realParent)) throw new Error("publication output parent escaped the repository root");
  const parentStat = lstatSync(parent);
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error("publication output parent must not be writable by group or other users");
  }
  const parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let staging: string | undefined;
  let stagingIdentity: { dev: number; ino: number } | undefined;
  let published = false;
  try {
    const parentIdentity = fstatSync(parentDescriptor);
    const assertPinnedParent = (): void => {
      assertNoSymlinkChain(root, parent, "publication output parent");
      const current = lstatSync(parent);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parentIdentity, current)
        || realpathSync(parent) !== realParent) throw new Error("publication output parent changed during write");
    };
    assertPinnedParent();
    staging = resolve(parent, `.publication-${randomUUID()}.tmp`);
    // Publication runs only after harness children have exited. A fresh 0700
    // directory keeps every untrusted/other-UID process out; the controller UID
    // is part of the trusted writer boundary and must not run hostile concurrent
    // filesystem mutations against its own staging inode.
    mkdirSync(staging, { mode: 0o700 });
    const stagingDescriptor = openSync(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const openedStaging = fstatSync(stagingDescriptor);
      stagingIdentity = { dev: Number(openedStaging.dev), ino: Number(openedStaging.ino) };
      const realStaging = realpathSync(staging);
      const assertPinnedStaging = (): void => {
        assertPinnedParent();
        const current = lstatSync(staging!);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(openedStaging, current)
          || realpathSync(staging!) !== realStaging) {
          throw new Error("publication staging directory changed during write");
        }
      };
      for (let index = 0; index < files.length; index += 1) {
        assertPinnedStaging();
        const relativePath = paths[index]!;
        const outputParent = ensureDirectory(staging, posix.dirname(relativePath) === "." ? "" : posix.dirname(relativePath));
        assertNoSymlinkChain(staging, outputParent, "publication staging output parent");
        const physicalParent = realpathSync(outputParent);
        if (!insideOrEqual(realStaging, physicalParent)) {
          throw new Error("publication staging output parent escaped the pinned staging directory");
        }
        const outputPath = resolve(staging, relativePath);
        const descriptor = openSync(
          outputPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const opened = fstatSync(descriptor);
          assertPinnedStaging();
          assertNoSymlinkChain(staging, outputPath, "publication staging output file");
          const current = lstatSync(outputPath);
          if (!opened.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)
            || !insideOrEqual(realStaging, realpathSync(outputPath))) {
            throw new Error("publication staging output file escaped its pinned staging directory");
          }
          writeFileSync(descriptor, files[index]!.bytes);
          fsyncSync(descriptor);
          const completed = fstatSync(descriptor);
          assertPinnedStaging();
          assertNoSymlinkChain(staging, outputPath, "publication staging output file");
          const finalStat = lstatSync(outputPath);
          if (!sameIdentity(opened, completed) || !sameIdentity(opened, finalStat)
            || completed.size !== files[index]!.bytes.length || finalStat.size !== completed.size
            || !insideOrEqual(realStaging, realpathSync(outputPath))) {
            throw new Error("publication staging output file changed during write");
          }
        } finally {
          closeSync(descriptor);
        }
      }
      const nestedDirectories = [...new Set(paths.flatMap((path) => {
        const directory = posix.dirname(path);
        if (directory === ".") return [];
        const segments = directory.split("/");
        return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
      }))]
        .sort((left, right) => right.split("/").length - left.split("/").length);
      for (const directory of nestedDirectories) {
        assertPinnedStaging();
        const directoryPath = resolve(staging, directory);
        assertNoSymlinkChain(staging, directoryPath, "publication staging directory");
        const descriptor = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(descriptor);
          const current = lstatSync(directoryPath);
          if (!opened.isDirectory() || current.isSymbolicLink() || !sameIdentity(opened, current)
            || !insideOrEqual(realStaging, realpathSync(directoryPath))) {
            throw new Error("publication staging directory escaped during fsync");
          }
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      validate?.(staging);
      assertPinnedStaging();
      fsyncSync(stagingDescriptor);
    } finally {
      closeSync(stagingDescriptor);
    }
    assertPinnedParent();
    const stagingCurrent = lstatSync(staging);
    if (!stagingCurrent.isDirectory() || stagingCurrent.isSymbolicLink()
      || !sameIdentity(stagingIdentity, stagingCurrent)) {
      throw new Error("publication staging directory changed before rename");
    }
    if (existsSync(output)) throw new Error("publication output appeared during write");
    renameSync(staging, output);
    published = true;
    fsyncSync(parentDescriptor);
    const completed = lstatSync(output);
    if (!completed.isDirectory() || completed.isSymbolicLink() || !sameIdentity(stagingIdentity, completed)
      || !insideOrEqual(realParent, realpathSync(output))) {
      throw new Error("publication output escaped its pinned parent");
    }
    return output;
  } catch (error) {
    if (published && existsSync(output)) {
      const current = lstatSync(output);
      if (stagingIdentity && current.isDirectory() && !current.isSymbolicLink()
        && sameIdentity(stagingIdentity, current)) rmSync(output, { recursive: true, force: true });
    }
    if (staging && existsSync(staging)) {
      const current = lstatSync(staging);
      if (stagingIdentity && current.isDirectory() && !current.isSymbolicLink()
        && sameIdentity(stagingIdentity, current)) rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  } finally {
    closeSync(parentDescriptor);
  }
}
