/**
 * On-disk layout for the AXArena / DAEB publication contract.
 *
 * Tool-layer example packs stay under `targets/examples/`. Arena-owned files
 * are canonical under `ax-arena/benchmark/daeb/`; the former
 * `benchmarks/daeb/` root is read-only compatibility for one minor release.
 */
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DAEB_BENCHMARK_ROOT = "ax-arena/benchmark/daeb";
export const DAEB_LEGACY_BENCHMARK_ROOT = "benchmarks/daeb";
/** Active publication version directory name. */
export const DAEB_ACTIVE_VERSION = "v1";

export interface DaebBenchmarkRootOptions {
  access: "read" | "write";
  explicitRoot?: string;
  warn?: (message: string) => void;
}

export interface DaebPathContext {
  readonly [DAEB_PATH_CONTEXT]: true;
  readonly repositoryRoot: string;
  readonly readRoot: string;
  readonly writeRoot: string;
  readonly explicitReadRoot: boolean;
  readonly readRootKind: "canonical" | "legacy" | "explicit";
}

export type DaebPathInput = string | DaebPathContext;

const warnedLegacyRoots = new Set<string>();
const DAEB_PATH_CONTEXT: unique symbol = Symbol("ax-arena.daeb-path-context");

function absoluteRoot(repositoryRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a single safe path segment: ${value}`);
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertRealDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or file: ${path}`);
  }
}

function assertRealInRepositoryPath(repositoryRoot: string, path: string, label: string): void {
  const root = resolve(repositoryRoot);
  const candidate = resolve(path);
  if (!contained(root, candidate)) throw new Error(`${label} must stay inside repository root: ${candidate}`);
  assertRealDirectory(root, "repository root");
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} cannot traverse a symlink or non-directory: ${current}`);
    }
  }
}

function warnLegacyRoot(
  legacy: string,
  canonical: string,
  warn?: (message: string) => void,
): void {
  const message = `deprecated benchmark root ${legacy}; move artifacts to ${canonical} (legacy reads are removed after one minor release)`;
  if (warn) warn(message);
  else if (!warnedLegacyRoots.has(legacy)) {
    warnedLegacyRoots.add(legacy);
    console.warn(message);
  }
}
export function resolveDaebBenchmarkRoot(
  repositoryRoot: string,
  options: DaebBenchmarkRootOptions,
): string {
  const root = resolve(repositoryRoot);
  const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
  const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
  assertRealInRepositoryPath(root, canonical, "canonical benchmark root");
  assertRealInRepositoryPath(root, legacy, "legacy benchmark root");

  if (options.access === "write") {
    if (options.explicitRoot && absoluteRoot(root, options.explicitRoot) !== canonical) {
      throw new Error(`writers use only the canonical benchmark root: ${canonical}`);
    }
    return canonical;
  }

  if (options.explicitRoot) {
    const explicit = absoluteRoot(root, options.explicitRoot);
    assertRealDirectory(explicit, "explicit benchmark root");
    if (explicit === legacy) warnLegacyRoot(legacy, canonical, options.warn);
    return explicit;
  }
  const hasCanonical = existsSync(canonical);
  const hasLegacy = existsSync(legacy);
  if (hasCanonical && hasLegacy) {
    throw new Error(
      `ambiguous benchmark roots: both ${canonical} and ${legacy} exist; pass --benchmark-root <path> explicitly`,
    );
  }
  if (hasLegacy) {
    warnLegacyRoot(legacy, canonical, options.warn);
    return legacy;
  }
  return canonical;
}

export function createDaebPathContext(
  repositoryRoot: string,
  options: Omit<DaebBenchmarkRootOptions, "access"> = {},
): DaebPathContext {
  const root = resolve(repositoryRoot);
  const readRoot = resolveDaebBenchmarkRoot(root, { ...options, access: "read" });
  const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
  const context = {
    repositoryRoot: root,
    readRoot,
    writeRoot: resolveDaebBenchmarkRoot(root, { access: "write" }),
    explicitReadRoot: options.explicitRoot !== undefined,
    readRootKind: options.explicitRoot !== undefined
      ? "explicit" as const
      : readRoot === canonical
        ? "canonical" as const
        : "legacy" as const,
  } as DaebPathContext;
  Object.defineProperty(context, DAEB_PATH_CONTEXT, { value: true });
  return Object.freeze(context);
}

function assertPathContext(input: DaebPathContext): DaebPathContext {
  if (input[DAEB_PATH_CONTEXT] !== true) {
    throw new Error("DAEB path context must be created by createDaebPathContext");
  }
  const repositoryRoot = resolve(input.repositoryRoot);
  const expectedWriteRoot = resolveDaebBenchmarkRoot(repositoryRoot, { access: "write" });
  if (resolve(input.writeRoot) !== expectedWriteRoot) {
    throw new Error(`DAEB path context write root must be canonical: ${expectedWriteRoot}`);
  }
  const expectedReadRoot = input.readRootKind === "canonical"
    ? resolve(repositoryRoot, DAEB_BENCHMARK_ROOT)
    : input.readRootKind === "legacy"
      ? resolve(repositoryRoot, DAEB_LEGACY_BENCHMARK_ROOT)
      : resolve(input.readRoot);
  if (resolve(input.readRoot) !== expectedReadRoot) {
    throw new Error(`DAEB path context read root no longer matches root policy: ${expectedReadRoot}`);
  }
  if (input.readRootKind === "explicit") assertRealDirectory(expectedReadRoot, "explicit benchmark root");
  else assertRealInRepositoryPath(repositoryRoot, expectedReadRoot, `${input.readRootKind} benchmark root`);
  return input;
}

function readRoot(input: DaebPathInput): string {
  return typeof input === "string"
    ? resolveDaebBenchmarkRoot(input, { access: "read" })
    : assertPathContext(input).readRoot;
}

export function daebRepositoryRoot(input: DaebPathInput): string {
  return resolve(typeof input === "string" ? input : assertPathContext(input).repositoryRoot);
}

function writeRoot(input: DaebPathInput): string {
  const repositoryRoot = daebRepositoryRoot(input);
  if (typeof input === "string") resolveDaebBenchmarkRoot(repositoryRoot, { access: "read" });
  else assertPathContext(input);
  return resolveDaebBenchmarkRoot(repositoryRoot, { access: "write" });
}

/** Resolve an explicit writer destination and reject paths outside canonical DAEB. */
export function assertCanonicalDaebWritePath(input: DaebPathInput, path: string): string {
  const root = writeRoot(input);
  const repositoryRoot = daebRepositoryRoot(input);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  if (!contained(root, candidate)) {
    throw new Error(`writers use only the canonical benchmark root: ${root}`);
  }
  assertRealInRepositoryPath(repositoryRoot, resolve(candidate, ".."), "canonical benchmark writer parent");
  try {
    const target = lstatSync(candidate);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error(`canonical benchmark writer target must be a regular non-symlink file: ${candidate}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

/** Canonical-only root used by every writer. */
export function daebRoot(root: DaebPathInput): string {
  return writeRoot(root);
}

export function daebReadRoot(root: DaebPathInput): string {
  return readRoot(root);
}

export function daebVendorsDir(root: DaebPathInput): string {
  return resolve(daebRoot(root), "vendors");
}

export function daebReadVendorsDir(root: DaebPathInput): string {
  return resolve(daebReadRoot(root), "vendors");
}

export function daebVersionDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebRoot(root), safeSegment(version, "benchmark version"));
}

export function daebReadVersionDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadRoot(root), safeSegment(version, "benchmark version"));
}

export function daebSuitePath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(root, resolve(daebVersionDir(root, version), "suite.yaml"));
}

export function daebReadSuitePath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVersionDir(root, version), "suite.yaml");
}

export function daebVendorSelectionLedgerPath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVersionDir(root, version), "vendor-selection-ledger.yaml"),
  );
}

export function daebReadVendorSelectionLedgerPath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVersionDir(root, version), "vendor-selection-ledger.yaml");
}

export function daebExtractsDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "extracts");
}

export function daebReadExtractsDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVersionDir(root, version), "extracts");
}

export function daebVendorExtractDir(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebExtractsDir(root, version), safeSegment(slug, "vendor slug"));
}

export function daebReadVendorExtractDir(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadExtractsDir(root, version), safeSegment(slug, "vendor slug"));
}

export function daebCapabilityInventoryPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVendorExtractDir(root, slug, version), "capability-inventory.yaml"),
  );
}

export function daebReadCapabilityInventoryPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "capability-inventory.yaml");
}

export function daebLegacyCapabilitiesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVendorExtractDir(root, slug, version), "capabilities.yaml"),
  );
}

export function daebReadLegacyCapabilitiesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "capabilities.yaml");
}

export function daebSurfacesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVendorExtractDir(root, slug, version), "surfaces.yaml"),
  );
}

export function daebReadSurfacesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "surfaces.yaml");
}

export function daebOraclesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVendorExtractDir(root, slug, version), "oracles.yaml"),
  );
}

export function daebReadOraclesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "oracles.yaml");
}

export function daebPacksDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "packs");
}

export function daebReadPacksDir(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVersionDir(root, version), "packs");
}

export function daebCompiledPackPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebPacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml"),
  );
}

export function daebReadCompiledPackPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadPacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml");
}

export function daebVendorCardPath(root: DaebPathInput, slug: string): string {
  return assertCanonicalDaebWritePath(
    root,
    resolve(daebVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`),
  );
}

export function daebReadVendorCardPath(root: DaebPathInput, slug: string): string {
  return resolve(daebReadVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`);
}

export function daebArchiveDir(root: DaebPathInput): string {
  return resolve(daebRoot(root), "_archive");
}
