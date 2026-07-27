/**
 * On-disk layout for the AXArena-Database publication contract.
 *
 * Tool-layer example packs stay under `targets/examples/`. Arena-owned files
 * are canonical under `ax-arena/benchmark/axarena-database/`. The former arena
 * and repository-level AXArena-Database roots remain read-only compatibility paths.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const AXARENA_DATABASE_BENCHMARK_ROOT = "ax-arena/benchmark/axarena-database";
export const AXARENA_DATABASE_LEGACY_ARENA_ROOT = "ax-arena/benchmark/daeb";
export const AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT = "benchmarks/daeb";
/** Active publication version directory name. */
export const AXARENA_DATABASE_ACTIVE_VERSION = "v1";

export interface AxevalDatabaseBenchmarkRootOptions {
  access: "read" | "write";
  explicitRoot?: string;
  warn?: (message: string) => void;
}

export interface AxevalDatabasePathContext {
  readonly [AXARENA_DATABASE_PATH_CONTEXT]: true;
  readonly repositoryRoot: string;
  readonly readRoot: string;
  readonly writeRoot: string;
  readonly explicitReadRoot: boolean;
  readonly readRootKind: "canonical" | "legacy-arena" | "legacy-repository" | "explicit";
}

export type AxevalDatabasePathInput = string | AxevalDatabasePathContext;

const warnedLegacyRoots = new Set<string>();
const AXARENA_DATABASE_PATH_CONTEXT: unique symbol = Symbol("axarena-database.path-context");

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

function hasLegacyBenchmarkArtifacts(root: string): boolean {
  if (existsSync(resolve(root, "v1", "suite.yaml"))) return true;
  const containsFile = (path: string, depth = 0): boolean => {
    if (!existsSync(path) || depth > 3) return false;
    return readdirSync(path, { withFileTypes: true }).some((entry) =>
      entry.isFile() || entry.isDirectory() && containsFile(resolve(path, entry.name), depth + 1));
  };
  return [resolve(root, "v1", "extracts"), resolve(root, "v1", "packs"), resolve(root, "vendors")]
    .some((path) => containsFile(path));
}

export function resolveAxevalDatabaseBenchmarkRoot(
  repositoryRoot: string,
  options: AxevalDatabaseBenchmarkRootOptions,
): string {
  const root = resolve(repositoryRoot);
  const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);
  const legacyArena = resolve(root, AXARENA_DATABASE_LEGACY_ARENA_ROOT);
  const legacyRepository = resolve(root, AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT);
  assertRealInRepositoryPath(root, canonical, "canonical benchmark root");
  assertRealInRepositoryPath(root, legacyArena, "legacy arena benchmark root");
  assertRealInRepositoryPath(root, legacyRepository, "legacy repository benchmark root");

  if (options.access === "write") {
    if (options.explicitRoot && absoluteRoot(root, options.explicitRoot) !== canonical) {
      throw new Error(`writers use only the canonical benchmark root: ${canonical}`);
    }
    return canonical;
  }

  if (options.explicitRoot) {
    const explicit = absoluteRoot(root, options.explicitRoot);
    assertRealDirectory(explicit, "explicit benchmark root");
    if (explicit === legacyArena || explicit === legacyRepository) {
      warnLegacyRoot(explicit, canonical, options.warn);
    }
    return explicit;
  }
  const existingRoots = [
    canonical,
    ...(hasLegacyBenchmarkArtifacts(legacyArena) ? [legacyArena] : []),
    ...(hasLegacyBenchmarkArtifacts(legacyRepository) ? [legacyRepository] : []),
  ].filter((candidate, index, candidates) => existsSync(candidate) && candidates.indexOf(candidate) === index);
  if (existingRoots.length > 1) {
    throw new Error(
      `ambiguous benchmark roots: ${existingRoots.join(", ")} exist; pass --benchmark-root <path> explicitly`,
    );
  }
  if (existingRoots[0] && existingRoots[0] !== canonical) {
    warnLegacyRoot(existingRoots[0], canonical, options.warn);
    return existingRoots[0];
  }
  return canonical;
}

export function createAxevalDatabasePathContext(
  repositoryRoot: string,
  options: Omit<AxevalDatabaseBenchmarkRootOptions, "access"> = {},
): AxevalDatabasePathContext {
  const root = resolve(repositoryRoot);
  const readRoot = resolveAxevalDatabaseBenchmarkRoot(root, { ...options, access: "read" });
  const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);
  const context = {
    repositoryRoot: root,
    readRoot,
    writeRoot: resolveAxevalDatabaseBenchmarkRoot(root, { access: "write" }),
    explicitReadRoot: options.explicitRoot !== undefined,
    readRootKind: options.explicitRoot !== undefined
      ? "explicit" as const
      : readRoot === canonical
        ? "canonical" as const
        : readRoot === resolve(root, AXARENA_DATABASE_LEGACY_ARENA_ROOT)
          ? "legacy-arena" as const
          : "legacy-repository" as const,
  } as AxevalDatabasePathContext;
  Object.defineProperty(context, AXARENA_DATABASE_PATH_CONTEXT, { value: true });
  return Object.freeze(context);
}

function assertPathContext(input: AxevalDatabasePathContext): AxevalDatabasePathContext {
  if (input[AXARENA_DATABASE_PATH_CONTEXT] !== true) {
    throw new Error("AXArena-Database path context must be created by createAxevalDatabasePathContext");
  }
  const repositoryRoot = resolve(input.repositoryRoot);
  const expectedWriteRoot = resolveAxevalDatabaseBenchmarkRoot(repositoryRoot, { access: "write" });
  if (resolve(input.writeRoot) !== expectedWriteRoot) {
    throw new Error(`AXArena-Database path context write root must be canonical: ${expectedWriteRoot}`);
  }
  const expectedReadRoot = input.readRootKind === "canonical"
    ? resolve(repositoryRoot, AXARENA_DATABASE_BENCHMARK_ROOT)
    : input.readRootKind === "legacy-arena"
      ? resolve(repositoryRoot, AXARENA_DATABASE_LEGACY_ARENA_ROOT)
      : input.readRootKind === "legacy-repository"
        ? resolve(repositoryRoot, AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT)
        : resolve(input.readRoot);
  if (resolve(input.readRoot) !== expectedReadRoot) {
    throw new Error(`AXArena-Database path context read root no longer matches root policy: ${expectedReadRoot}`);
  }
  if (input.readRootKind === "explicit") assertRealDirectory(expectedReadRoot, "explicit benchmark root");
  else assertRealInRepositoryPath(repositoryRoot, expectedReadRoot, `${input.readRootKind} benchmark root`);
  return input;
}

function readRoot(input: AxevalDatabasePathInput): string {
  return typeof input === "string"
    ? resolveAxevalDatabaseBenchmarkRoot(input, { access: "read" })
    : assertPathContext(input).readRoot;
}

export function axevalDatabaseRepositoryRoot(input: AxevalDatabasePathInput): string {
  return resolve(typeof input === "string" ? input : assertPathContext(input).repositoryRoot);
}

function writeRoot(input: AxevalDatabasePathInput): string {
  const repositoryRoot = axevalDatabaseRepositoryRoot(input);
  // A bare repository root carries no explicit root selection. Validate the
  // read-side compatibility state first so direct library writers fail on the
  // same canonical+legacy ambiguity as CLI callers.
  if (typeof input === "string") resolveAxevalDatabaseBenchmarkRoot(repositoryRoot, { access: "read" });
  else assertPathContext(input);
  return resolveAxevalDatabaseBenchmarkRoot(repositoryRoot, { access: "write" });
}

/** Resolve an explicit writer destination and reject paths outside AXArena-Database. */
export function assertCanonicalAxevalDatabaseWritePath(input: AxevalDatabasePathInput, path: string): string {
  const root = writeRoot(input);
  const repositoryRoot = axevalDatabaseRepositoryRoot(input);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  if (!contained(root, candidate)) {
    throw new Error(`writers use only the canonical benchmark root: ${root}`);
  }
  assertRealInRepositoryPath(repositoryRoot, resolve(candidate, ".."), "canonical benchmark writer parent");
  try {
    const target = lstatSync(candidate);
    if (target.isSymbolicLink() || !target.isFile() || target.nlink !== 1) {
      throw new Error(`canonical benchmark writer target must be a regular, single-link non-symlink file: ${candidate}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

/** Suite writers use one unambiguous stem and the canonical lowercase extension. */
export function assertCanonicalAxevalDatabaseSuiteWritePath(input: AxevalDatabasePathInput, path: string): string {
  const candidate = assertCanonicalAxevalDatabaseWritePath(input, path);
  if (!candidate.endsWith(".yaml")) {
    throw new Error(`suite writers require a canonical lowercase .yaml path: ${candidate}`);
  }
  return candidate;
}

/** Canonical-only root used by every writer. */
export function axevalDatabaseRoot(root: AxevalDatabasePathInput): string {
  return writeRoot(root);
}

export function axevalDatabaseReadRoot(root: AxevalDatabasePathInput): string {
  return readRoot(root);
}

export function axevalDatabaseVendorsDir(root: AxevalDatabasePathInput): string {
  return resolve(axevalDatabaseRoot(root), "vendors");
}

export function axevalDatabaseReadVendorsDir(root: AxevalDatabasePathInput): string {
  return resolve(axevalDatabaseReadRoot(root), "vendors");
}

export function axevalDatabaseVersionDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseRoot(root), safeSegment(version, "benchmark version"));
}

export function axevalDatabaseReadVersionDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadRoot(root), safeSegment(version, "benchmark version"));
}

export function axevalDatabaseSuitePath(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(root, resolve(axevalDatabaseVersionDir(root, version), "suite.yaml"));
}

export function axevalDatabaseReadSuitePath(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVersionDir(root, version), "suite.yaml");
}

export function axevalDatabaseVendorSelectionLedgerPath(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVersionDir(root, version), "vendor-selection-ledger.yaml"),
  );
}

export function axevalDatabaseReadVendorSelectionLedgerPath(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVersionDir(root, version), "vendor-selection-ledger.yaml");
}

export function axevalDatabaseExtractsDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseVersionDir(root, version), "extracts");
}

export function axevalDatabaseReadExtractsDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVersionDir(root, version), "extracts");
}

export function axevalDatabaseVendorExtractDir(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseExtractsDir(root, version), safeSegment(slug, "vendor slug"));
}

export function axevalDatabaseReadVendorExtractDir(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadExtractsDir(root, version), safeSegment(slug, "vendor slug"));
}

export function axevalDatabaseCapabilityInventoryPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVendorExtractDir(root, slug, version), "capability-inventory.yaml"),
  );
}

export function axevalDatabaseReadCapabilityInventoryPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVendorExtractDir(root, slug, version), "capability-inventory.yaml");
}

export function axevalDatabaseLegacyCapabilitiesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVendorExtractDir(root, slug, version), "capabilities.yaml"),
  );
}

export function axevalDatabaseReadLegacyCapabilitiesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVendorExtractDir(root, slug, version), "capabilities.yaml");
}

export function axevalDatabaseSurfacesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVendorExtractDir(root, slug, version), "surfaces.yaml"),
  );
}

export function axevalDatabaseReadSurfacesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVendorExtractDir(root, slug, version), "surfaces.yaml");
}

export function axevalDatabaseOraclesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVendorExtractDir(root, slug, version), "oracles.yaml"),
  );
}

export function axevalDatabaseReadOraclesPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVendorExtractDir(root, slug, version), "oracles.yaml");
}

export function axevalDatabasePacksDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseVersionDir(root, version), "packs");
}

export function axevalDatabaseReadPacksDir(root: AxevalDatabasePathInput, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadVersionDir(root, version), "packs");
}

export function axevalDatabaseCompiledPackPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabasePacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml"),
  );
}

export function axevalDatabaseReadCompiledPackPath(root: AxevalDatabasePathInput, slug: string, version: string = AXARENA_DATABASE_ACTIVE_VERSION): string {
  return resolve(axevalDatabaseReadPacksDir(root, version), safeSegment(slug, "vendor slug"), "pack.yaml");
}

export function axevalDatabaseVendorCardPath(root: AxevalDatabasePathInput, slug: string): string {
  return assertCanonicalAxevalDatabaseWritePath(
    root,
    resolve(axevalDatabaseVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`),
  );
}

export function axevalDatabaseReadVendorCardPath(root: AxevalDatabasePathInput, slug: string): string {
  return resolve(axevalDatabaseReadVendorsDir(root), `${safeSegment(slug, "vendor slug")}.discovered.yaml`);
}

export function axevalDatabaseArchiveDir(root: AxevalDatabasePathInput): string {
  return resolve(axevalDatabaseRoot(root), "_archive");
}
