import { dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { z } from "zod";
import {
  CapabilityExtractResultSchema,
  CapabilityInventorySchema,
  LegacyCapabilityExtractSchema,
  OracleExtractResultSchema,
  ResolveResultSchema,
  SurfaceExtractResultSchema,
  auditSurfaceExtract,
  normalizeLegacyCapabilityExtract,
  type CapabilityExtractResult,
  type CapabilityInventory,
  type OracleExtractResult,
  type ResolveResult,
  type SuiteMethodology,
  type SurfaceExtractResult,
} from "ax-eval";
import {
  CoverageMatrixSchema,
  SelectionLedgerSchema,
  SupportMatrixSchema,
  TraceReviewMemoSchema,
  type ConceptUniverse,
  type CoverageMatrix,
  type FailureTaxonomy,
  type GraderLedger,
  type SelectionLedger,
  type SupportMatrix,
  type TraceReviewMemo,
} from "./artifact-contracts.js";
import { auditCapabilityInventory } from "./inventory-audit.js";
import { readContainedText, writeContainedText } from "./artifact-filesystem.js";
import {
  assertCanonicalAxevalDatabaseWritePath,
  axevalDatabaseCapabilityInventoryPath,
  axevalDatabaseLegacyCapabilitiesPath,
  axevalDatabaseOraclesPath,
  axevalDatabaseReadCapabilityInventoryPath,
  axevalDatabaseReadLegacyCapabilitiesPath,
  axevalDatabaseReadOraclesPath,
  axevalDatabaseReadRoot,
  axevalDatabaseReadSurfacesPath,
  axevalDatabaseReadVendorCardPath,
  axevalDatabaseRepositoryRoot,
  axevalDatabaseRoot,
  axevalDatabaseSurfacesPath,
  axevalDatabaseVendorCardPath,
  type AxevalDatabasePathInput,
} from "./benchmark-paths.js";

function parseYaml<TSchema extends z.ZodTypeAny>(
  raw: string,
  path: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> {
  const result = schema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`${label} at ${path} is malformed: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

function readAxevalDatabaseYaml<TSchema extends z.ZodTypeAny>(
  root: AxevalDatabasePathInput,
  path: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> | null {
  const readRoot = axevalDatabaseReadRoot(root);
  const raw = readContainedText(readRoot, readRoot, path, label);
  return raw === null ? null : parseYaml(raw, path, schema, label);
}

function writeAxevalDatabaseText(root: AxevalDatabasePathInput, path: string, contents: string, label: string): string {
  const canonical = assertCanonicalAxevalDatabaseWritePath(root, path);
  return writeContainedText(axevalDatabaseRepositoryRoot(root), axevalDatabaseRoot(root), canonical, contents, label);
}

function explicitArtifactPath(root: AxevalDatabasePathInput, suitePath: string, suffix: string): string {
  return `${resolve(axevalDatabaseRepositoryRoot(root), suitePath).replace(/\.yaml$/i, "")}${suffix}`;
}

function readExplicitYaml<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> | null {
  const parent = dirname(path);
  const raw = readContainedText(parent, parent, path, label);
  return raw === null ? null : parseYaml(raw, path, schema, label);
}

function writeMethodologyArtifact(root: AxevalDatabasePathInput, path: string, value: unknown, label: string): string {
  const canonical = assertCanonicalAxevalDatabaseWritePath(root, path);
  return writeContainedText(axevalDatabaseRepositoryRoot(root), axevalDatabaseRoot(root), canonical, yamlStringify(value), label);
}

export function vendorCardPath(root: AxevalDatabasePathInput, slug: string): string {
  return axevalDatabaseVendorCardPath(root, slug);
}

export function writeVendorCard(root: AxevalDatabasePathInput, result: ResolveResult): string {
  return writeAxevalDatabaseText(root, vendorCardPath(root, result.slug), yamlStringify(result), "vendor card");
}

export function loadVendorCard(root: AxevalDatabasePathInput, slug: string): ResolveResult | null {
  return readAxevalDatabaseYaml(root, axevalDatabaseReadVendorCardPath(root, slug), ResolveResultSchema, "vendor card");
}

export function capabilityInventoryPath(root: AxevalDatabasePathInput, slug: string): string {
  return axevalDatabaseCapabilityInventoryPath(root, slug);
}

export function legacyCapabilityExtractPath(root: AxevalDatabasePathInput, slug: string): string {
  return axevalDatabaseLegacyCapabilitiesPath(root, slug);
}

const CAPABILITY_INVENTORY_HEADER = [
  "# Cited capability inventory (suite authoring Layer 0a).",
  "# Each entry's surfaces_documented records which surfaces the official docs say can",
  "# perform that capability - per-capability documentation attribution for coverage",
  "# synthesis, not the same as surfaces.yaml (CLI/SDK/MCP install/auth for the agent).",
  "",
].join("\n");

export function writeCapabilityInventory(root: AxevalDatabasePathInput, inventory: CapabilityInventory): string {
  return writeAxevalDatabaseText(
    root,
    capabilityInventoryPath(root, inventory.slug),
    `${CAPABILITY_INVENTORY_HEADER}${yamlStringify(auditCapabilityInventory(inventory))}`,
    "capability inventory",
  );
}

export function loadCapabilityInventory(root: AxevalDatabasePathInput, slug: string): CapabilityInventory | null {
  return readAxevalDatabaseYaml(root, axevalDatabaseReadCapabilityInventoryPath(root, slug), CapabilityInventorySchema, "capability inventory")
    ?? readAxevalDatabaseYaml(root, axevalDatabaseReadLegacyCapabilitiesPath(root, slug), CapabilityInventorySchema, "legacy capability inventory");
}

export function capabilityExtractPath(root: AxevalDatabasePathInput, slug: string): string {
  return capabilityInventoryPath(root, slug);
}

export function writeCapabilityExtract(root: AxevalDatabasePathInput, result: CapabilityExtractResult): string {
  return writeCapabilityInventory(root, result);
}

export function loadCapabilityExtract(root: AxevalDatabasePathInput, slug: string): CapabilityExtractResult | null {
  const inventoryPath = axevalDatabaseReadCapabilityInventoryPath(root, slug);
  const legacyPath = axevalDatabaseReadLegacyCapabilitiesPath(root, slug);
  const inventoryRaw = readContainedText(axevalDatabaseReadRoot(root), axevalDatabaseReadRoot(root), inventoryPath, "capability extract");
  const legacyRaw = readContainedText(axevalDatabaseReadRoot(root), axevalDatabaseReadRoot(root), legacyPath, "legacy capability extract");
  if (inventoryRaw !== null) {
    const inventory = CapabilityExtractResultSchema.safeParse(yamlParse(inventoryRaw));
    if (inventory.success) {
      const normalizedLegacy = inventory.data.capabilities.some(
        (capability) => capability.extraction_provenance.extractor === "legacy-capabilities-normalizer-v1",
      );
      if (!normalizedLegacy || legacyRaw === null) return inventory.data;
    }
    if (!inventory.success && legacyRaw === null) {
      throw new Error(
        `capability-extract at ${inventoryPath} is malformed: ${inventory.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
  }
  if (legacyRaw === null) return null;
  const legacy = LegacyCapabilityExtractSchema.safeParse(yamlParse(legacyRaw));
  if (legacy.success) {
    const normalized = normalizeLegacyCapabilityExtract(legacy.data);
    writeCapabilityInventory(root, normalized);
    return normalized;
  }
  return parseYaml(legacyRaw, legacyPath, CapabilityExtractResultSchema, "capability extract");
}

export function surfaceExtractPath(root: AxevalDatabasePathInput, slug: string): string {
  return axevalDatabaseSurfacesPath(root, slug);
}

const SURFACE_EXTRACT_HEADER = [
  "# Optional agent surface adapters for exec-plan (CLI / SDK / MCP only).",
  "# REST API is always the implicit default surface and is intentionally omitted here;",
  "# API auth and base URL come from the vendor oracle extract, not this file.",
  "",
].join("\n");

export function writeSurfaceExtract(root: AxevalDatabasePathInput, result: SurfaceExtractResult): string {
  return writeAxevalDatabaseText(
    root,
    surfaceExtractPath(root, result.slug),
    `${SURFACE_EXTRACT_HEADER}${yamlStringify(auditSurfaceExtract(result))}`,
    "surface extract",
  );
}

export function loadSurfaceExtract(root: AxevalDatabasePathInput, slug: string): SurfaceExtractResult | null {
  return readAxevalDatabaseYaml(root, axevalDatabaseReadSurfacesPath(root, slug), SurfaceExtractResultSchema, "surface extract");
}

export function oracleExtractPath(root: AxevalDatabasePathInput, slug: string, _suiteName: string): string {
  return axevalDatabaseOraclesPath(root, slug);
}

export function writeOracleExtract(root: AxevalDatabasePathInput, result: OracleExtractResult): string {
  return writeAxevalDatabaseText(
    root,
    oracleExtractPath(root, result.slug, result.suite_name),
    yamlStringify(result),
    "oracle extract",
  );
}

export function loadOracleExtract(root: AxevalDatabasePathInput, slug: string, _suiteName: string): OracleExtractResult | null {
  return readAxevalDatabaseYaml(root, axevalDatabaseReadOraclesPath(root, slug), OracleExtractResultSchema, "oracle extract");
}

export function methodologyPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".methodology.yaml");
}

export function conceptUniversePath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".concept-universe.yaml");
}

export function coverageMatrixPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".coverage-matrix.yaml");
}

export function selectionLedgerPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".selection-ledger.yaml");
}

export function supportMatrixPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".support-matrix.yaml");
}

export function graderLedgerPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".grader-ledger.yaml");
}

export function failureTaxonomyPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".failure-taxonomy.yaml");
}

export function traceReviewPath(root: AxevalDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".trace-review.yaml");
}

export function writeMethodology(root: AxevalDatabasePathInput, suitePath: string, value: SuiteMethodology): string {
  return writeMethodologyArtifact(root, methodologyPath(root, suitePath), value, "suite methodology");
}

export function writeConceptUniverse(root: AxevalDatabasePathInput, suitePath: string, value: ConceptUniverse): string {
  return writeMethodologyArtifact(root, conceptUniversePath(root, suitePath), value, "concept universe");
}

export function writeCoverageMatrix(root: AxevalDatabasePathInput, suitePath: string, value: CoverageMatrix): string {
  return writeMethodologyArtifact(root, coverageMatrixPath(root, suitePath), value, "coverage matrix");
}

export function writeSelectionLedger(root: AxevalDatabasePathInput, suitePath: string, value: SelectionLedger): string {
  return writeMethodologyArtifact(root, selectionLedgerPath(root, suitePath), value, "selection ledger");
}

export function writeSupportMatrix(root: AxevalDatabasePathInput, suitePath: string, value: SupportMatrix): string {
  return writeMethodologyArtifact(root, supportMatrixPath(root, suitePath), value, "support matrix");
}

export function writeGraderLedger(root: AxevalDatabasePathInput, suitePath: string, value: GraderLedger): string {
  return writeMethodologyArtifact(root, graderLedgerPath(root, suitePath), value, "grader ledger");
}

export function writeFailureTaxonomy(root: AxevalDatabasePathInput, suitePath: string, value: FailureTaxonomy): string {
  return writeMethodologyArtifact(root, failureTaxonomyPath(root, suitePath), value, "failure taxonomy");
}

export function writeTraceReview(root: AxevalDatabasePathInput, suitePath: string, value: TraceReviewMemo): string {
  return writeMethodologyArtifact(root, traceReviewPath(root, suitePath), value, "trace review");
}

export function loadTraceReview(root: AxevalDatabasePathInput, suitePath: string): TraceReviewMemo | null {
  return readExplicitYaml(traceReviewPath(root, suitePath), TraceReviewMemoSchema, "trace review");
}

export function loadSupportMatrix(root: AxevalDatabasePathInput, suitePath: string): SupportMatrix | null {
  return readExplicitYaml(supportMatrixPath(root, suitePath), SupportMatrixSchema, "support matrix");
}

export function loadCoverageMatrix(root: AxevalDatabasePathInput, suitePath: string): CoverageMatrix | null {
  return readExplicitYaml(coverageMatrixPath(root, suitePath), CoverageMatrixSchema, "coverage matrix");
}

export function loadSelectionLedger(root: AxevalDatabasePathInput, suitePath: string): SelectionLedger | null {
  return readExplicitYaml(selectionLedgerPath(root, suitePath), SelectionLedgerSchema, "selection ledger");
}
