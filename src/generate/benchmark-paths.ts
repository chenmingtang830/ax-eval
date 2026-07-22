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
  readonly repositoryRoot: string;
  readonly readRoot: string;
  readonly writeRoot: string;
}

export type DaebPathInput = string | DaebPathContext;

const warnedLegacyRoots = new Set<string>();

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

export function resolveDaebBenchmarkRoot(
  repositoryRoot: string,
  options: DaebBenchmarkRootOptions,
): string {
  const root = resolve(repositoryRoot);
  const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
  const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
  assertRealDirectory(canonical, "canonical benchmark root");
  assertRealDirectory(legacy, "legacy benchmark root");

  if (options.access === "write") {
    if (options.explicitRoot && absoluteRoot(root, options.explicitRoot) !== canonical) {
      throw new Error(`writers use only the canonical benchmark root: ${canonical}`);
    }
    return canonical;
  }

  if (options.explicitRoot) {
    const explicit = absoluteRoot(root, options.explicitRoot);
    assertRealDirectory(explicit, "explicit benchmark root");
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
    const message = `deprecated benchmark root ${legacy}; move artifacts to ${canonical} (legacy reads are removed after one minor release)`;
    if (options.warn) options.warn(message);
    else if (!warnedLegacyRoots.has(legacy)) {
      warnedLegacyRoots.add(legacy);
      console.warn(message);
    }
    return legacy;
  }
  return canonical;
}

export function createDaebPathContext(
  repositoryRoot: string,
  options: Omit<DaebBenchmarkRootOptions, "access"> = {},
): DaebPathContext {
  const root = resolve(repositoryRoot);
  return Object.freeze({
    repositoryRoot: root,
    readRoot: resolveDaebBenchmarkRoot(root, { ...options, access: "read" }),
    writeRoot: resolveDaebBenchmarkRoot(root, { access: "write" }),
  });
}

function readRoot(input: DaebPathInput): string {
  return typeof input === "string"
    ? resolveDaebBenchmarkRoot(input, { access: "read" })
    : input.readRoot;
}

function writeRoot(input: DaebPathInput): string {
  return typeof input === "string"
    ? resolveDaebBenchmarkRoot(input, { access: "write" })
    : input.writeRoot;
}

/** Resolve an explicit writer destination and reject paths outside canonical DAEB. */
export function assertCanonicalDaebWritePath(input: DaebPathInput, path: string): string {
  const root = writeRoot(input);
  const repositoryRoot = typeof input === "string" ? resolve(input) : input.repositoryRoot;
  const candidate = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  if (!contained(root, candidate)) {
    throw new Error(`writers use only the canonical benchmark root: ${root}`);
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
  return resolve(daebVersionDir(root, version), "suite.yaml");
}

export function daebReadSuitePath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVersionDir(root, version), "suite.yaml");
}

export function daebVendorSelectionLedgerPath(root: DaebPathInput, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "vendor-selection-ledger.yaml");
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
  return resolve(daebVendorExtractDir(root, slug, version), "capability-inventory.yaml");
}

export function daebReadCapabilityInventoryPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "capability-inventory.yaml");
}

export function daebLegacyCapabilitiesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "capabilities.yaml");
}

export function daebReadLegacyCapabilitiesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "capabilities.yaml");
}

export function daebSurfacesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "surfaces.yaml");
}

export function daebReadSurfacesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadVendorExtractDir(root, slug, version), "surfaces.yaml");
}

export function daebOraclesPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "oracles.yaml");
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
  return resolve(daebPacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml");
}

export function daebReadCompiledPackPath(root: DaebPathInput, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebReadPacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml");
}

export function daebVendorCardPath(root: DaebPathInput, slug: string): string {
  return resolve(daebVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`);
}

export function daebReadVendorCardPath(root: DaebPathInput, slug: string): string {
  return resolve(daebReadVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`);
}

export function daebArchiveDir(root: DaebPathInput): string {
  return resolve(daebRoot(root), "_archive");
}
