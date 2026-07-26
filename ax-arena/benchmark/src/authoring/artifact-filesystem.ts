import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function entryIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRealDirectory(path: string, label: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} cannot traverse a symlink or non-directory: ${path}`);
  }
  return stat;
}

function validateTree(
  repositoryRoot: string,
  parent: string,
  label: string,
  create: boolean,
): Stats {
  const root = resolve(repositoryRoot);
  const target = resolve(parent);
  if (!contained(root, target)) throw new Error(`${label} must stay inside repository root: ${target}`);
  assertRealDirectory(root, "repository root");
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const entry = entryIfPresent(current);
    if (!entry && create) mkdirSync(current);
    assertRealDirectory(current, label);
  }
  return assertRealDirectory(target, label);
}

function assertContained(allowedRoot: string, path: string, label: string): void {
  if (!contained(resolve(allowedRoot), resolve(path))) {
    throw new Error(`${label} must stay inside ${resolve(allowedRoot)}: ${resolve(path)}`);
  }
}

export function readContainedText(
  repositoryRoot: string,
  allowedRoot: string,
  path: string,
  label: string,
): string | null {
  const absolute = resolve(path);
  assertContained(allowedRoot, absolute, label);
  const initial = entryIfPresent(absolute);
  if (!initial) return null;
  const parent = dirname(absolute);
  const parentBefore = validateTree(repositoryRoot, parent, `${label} parent`, false);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1) {
    throw new Error(`${label} must be a regular, single-link non-symlink file: ${absolute}`);
  }
  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const parentOpened = fstatSync(parentDescriptor);
    const parentAfter = lstatSync(parent);
    const opened = fstatSync(descriptor);
    const current = lstatSync(absolute);
    if (
      parentAfter.isSymbolicLink()
      || parentAfter.dev !== parentBefore.dev
      || parentAfter.ino !== parentBefore.ino
      || parentOpened.dev !== parentBefore.dev
      || parentOpened.ino !== parentBefore.ino
      || initial.dev !== opened.dev
      || initial.ino !== opened.ino
      || !opened.isFile()
      || opened.nlink !== 1
      || current.isSymbolicLink()
      || current.nlink !== 1
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) {
      throw new Error(`${label} changed during no-follow validation: ${absolute}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parentDescriptor);
  }
}

export interface ContainedWriteHooks {
  beforeTempOpen?: (context: { parent: string; path: string }) => void;
  write?: (descriptor: number, contents: string) => void;
  beforeCommit?: (context: { parent: string; path: string; tempPath: string }) => void;
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStableParent(parent: string, expected: Stats, descriptor: number, label: string): void {
  const byPath = lstatSync(parent);
  const opened = fstatSync(descriptor);
  if (byPath.isSymbolicLink() || !byPath.isDirectory()
    || !sameInode(byPath, expected) || !sameInode(opened, expected)) {
    throw new Error(`${label} parent changed during atomic write: ${parent}`);
  }
}

function assertStableTarget(path: string, expected: Stats | undefined, label: string): void {
  const current = entryIfPresent(path);
  if (!expected) {
    if (current) throw new Error(`${label} appeared during atomic write: ${path}`);
    return;
  }
  if (!current || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
    || !sameInode(current, expected)) {
    throw new Error(`${label} changed during atomic write: ${path}`);
  }
}

function assertStableTemporary(path: string, descriptor: number, label: string): Stats {
  const opened = fstatSync(descriptor);
  const current = lstatSync(path);
  if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
    || !current.isFile() || current.nlink !== 1 || !sameInode(opened, current)) {
    throw new Error(`${label} temporary output changed during atomic write: ${path}`);
  }
  return opened;
}

function unlinkSameInode(path: string, expected: Stats | undefined): void {
  if (!expected) return;
  const current = entryIfPresent(path);
  if (current && !current.isSymbolicLink() && sameInode(current, expected)) unlinkSync(path);
}

export function writeContainedText(
  repositoryRoot: string,
  allowedRoot: string,
  path: string,
  contents: string,
  label: string,
  hooks: ContainedWriteHooks = {},
): string {
  const absolute = resolve(path);
  assertContained(allowedRoot, absolute, label);
  const parent = dirname(absolute);
  const parentBefore = validateTree(repositoryRoot, parent, `${label} parent`, true);
  const existing = entryIfPresent(absolute);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error(`${label} must be a regular, single-link non-symlink file: ${absolute}`);
  }

  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let descriptor: number | undefined;
  let temporary: Stats | undefined;
  let tempPath: string | undefined;
  let committed = false;
  try {
    assertStableParent(parent, parentBefore, parentDescriptor, label);
    hooks.beforeTempOpen?.({ parent, path: absolute });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      tempPath = resolve(parent, `.${basename(absolute)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
      try {
        descriptor = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (descriptor === undefined || tempPath === undefined) {
      throw new Error(`could not reserve a unique ${label} temporary file: ${absolute}`);
    }
    temporary = fstatSync(descriptor);
    assertStableParent(parent, parentBefore, parentDescriptor, label);
    assertStableTemporary(tempPath, descriptor, label);
    assertStableTarget(absolute, existing, label);

    hooks.write ? hooks.write(descriptor, contents) : writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
    fsyncSync(descriptor);

    hooks.beforeCommit?.({ parent, path: absolute, tempPath });
    assertStableParent(parent, parentBefore, parentDescriptor, label);
    temporary = assertStableTemporary(tempPath, descriptor, label);
    assertStableTarget(absolute, existing, label);
    renameSync(tempPath, absolute);
    committed = true;

    assertStableParent(parent, parentBefore, parentDescriptor, label);
    const installed = lstatSync(absolute);
    if (installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1
      || !sameInode(installed, temporary)) {
      throw new Error(`${label} changed during atomic installation: ${absolute}`);
    }
    fsyncSync(parentDescriptor);
    return absolute;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!committed && tempPath) unlinkSameInode(tempPath, temporary);
    closeSync(parentDescriptor);
  }
}
