import { stringify as yamlStringify } from "yaml";
import {
  auditCapabilityInventory,
  auditSurfaceExtract,
  daebCapabilityInventoryPath,
  daebOraclesPath,
  daebRepositoryRoot,
  daebRoot,
  daebSurfacesPath,
  daebVendorCardPath,
  type CapabilityExtractResult,
  type CapabilityInventory,
  type DaebPathInput,
  type OracleExtractResult,
  type ResolveResult,
  type SurfaceExtractResult,
} from "ax-eval";
import { writeContainedText } from "./artifact-filesystem.js";

const SURFACE_EXTRACT_HEADER = [
  "# Optional agent surface adapters for exec-plan (CLI / SDK / MCP only).",
  "# REST API is always the implicit default surface and is intentionally omitted here;",
  "# API auth and base URL come from the vendor oracle extract, not this file.",
  "",
].join("\n");

const CAPABILITY_INVENTORY_HEADER = [
  "# Cited capability inventory (suite authoring Layer 0a).",
  "# Each entry's surfaces_documented records which surfaces the official docs say can",
  "# perform that capability - per-capability documentation attribution for coverage",
  "# synthesis, not the same as surfaces.yaml (CLI/SDK/MCP install/auth for the agent).",
  "",
].join("\n");

function writeArtifact(
  root: DaebPathInput,
  path: string,
  contents: string,
  label: string,
): string {
  return writeContainedText(daebRepositoryRoot(root), daebRoot(root), path, contents, label);
}

export function writeVendorCard(root: DaebPathInput, result: ResolveResult): string {
  return writeArtifact(root, daebVendorCardPath(root, result.slug), yamlStringify(result), "vendor card");
}

export function writeSurfaceExtract(root: DaebPathInput, result: SurfaceExtractResult): string {
  return writeArtifact(
    root,
    daebSurfacesPath(root, result.slug),
    `${SURFACE_EXTRACT_HEADER}${yamlStringify(auditSurfaceExtract(result))}`,
    "surface extract",
  );
}

export function writeCapabilityInventory(root: DaebPathInput, inventory: CapabilityInventory): string {
  return writeArtifact(
    root,
    daebCapabilityInventoryPath(root, inventory.slug),
    `${CAPABILITY_INVENTORY_HEADER}${yamlStringify(auditCapabilityInventory(inventory))}`,
    "capability inventory",
  );
}

export function writeCapabilityExtract(root: DaebPathInput, result: CapabilityExtractResult): string {
  return writeCapabilityInventory(root, result);
}

export function writeOracleExtract(root: DaebPathInput, result: OracleExtractResult): string {
  return writeArtifact(root, daebOraclesPath(root, result.slug), yamlStringify(result), "oracle extract");
}
