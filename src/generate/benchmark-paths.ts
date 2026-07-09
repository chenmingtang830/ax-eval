/**
 * On-disk layout for the AXArena / DAEB publication contract.
 *
 * Tool-layer example packs stay under `targets/examples/`. Everything that is
 * the frozen DAEB reproducibility contract lives under `benchmarks/daeb/`.
 */
import { resolve } from "node:path";

export const DAEB_BENCHMARK_ROOT = "benchmarks/daeb";
/** Active publication version directory name. */
export const DAEB_ACTIVE_VERSION = "v1";

export function daebRoot(root: string): string {
  return resolve(root, DAEB_BENCHMARK_ROOT);
}

export function daebVendorsDir(root: string): string {
  return resolve(daebRoot(root), "vendors");
}

export function daebVersionDir(root: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebRoot(root), version);
}

export function daebSuitePath(root: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "suite.yaml");
}

export function daebExtractsDir(root: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "extracts");
}

export function daebVendorExtractDir(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebExtractsDir(root, version), slug);
}

export function daebCapabilityInventoryPath(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "capability-inventory.yaml");
}

export function daebLegacyCapabilitiesPath(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "capabilities.yaml");
}

export function daebSurfacesPath(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "surfaces.yaml");
}

export function daebOraclesPath(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVendorExtractDir(root, slug, version), "oracles.yaml");
}

export function daebPacksDir(root: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebVersionDir(root, version), "packs");
}

export function daebCompiledPackPath(root: string, slug: string, version: string = DAEB_ACTIVE_VERSION): string {
  return resolve(daebPacksDir(root, version), slug, "pack.yaml");
}

export function daebVendorCardPath(root: string, slug: string): string {
  return resolve(daebVendorsDir(root), `${slug}.discovered.yaml`);
}

export function daebArchiveDir(root: string): string {
  return resolve(daebRoot(root), "_archive");
}
