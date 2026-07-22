import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

function validateTree(repositoryRoot: string, parent: string, label: string): Stats {
  const root = resolve(repositoryRoot);
  const target = resolve(parent);
  if (!contained(root, target)) throw new Error(`${label} must stay inside repository root: ${target}`);
  assertRealDirectory(root, "repository root");
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const entry = entryIfPresent(current);
    if (!entry) mkdirSync(current);
    assertRealDirectory(current, label);
  }
  return assertRealDirectory(target, label);
}

/** Write a canonical artifact without following symlinks or hard links. */
export function writeContainedText(
  repositoryRoot: string,
  allowedRoot: string,
  path: string,
  contents: string,
  label: string,
): string {
  const absolute = resolve(path);
  if (!contained(resolve(allowedRoot), absolute)) {
    throw new Error(`${label} must stay inside ${resolve(allowedRoot)}: ${absolute}`);
  }
  const parent = dirname(absolute);
  const parentBefore = validateTree(repositoryRoot, parent, `${label} parent`);
  const existing = entryIfPresent(absolute);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error(`${label} must be a regular, single-link non-symlink file: ${absolute}`);
  }

  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o666,
    );
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
      || !opened.isFile()
      || opened.nlink !== 1
      || current.isSymbolicLink()
      || current.nlink !== 1
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) {
      throw new Error(`${label} changed during no-follow validation: ${absolute}`);
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, contents, "utf8");
    const completed = lstatSync(absolute);
    if (
      completed.isSymbolicLink()
      || completed.nlink !== 1
      || completed.dev !== opened.dev
      || completed.ino !== opened.ino
    ) {
      throw new Error(`${label} changed while writing: ${absolute}`);
    }
    return absolute;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parentDescriptor);
  }
}
