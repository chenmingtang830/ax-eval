import { dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { z } from "zod";
import {
  CapabilityExtractResultSchema,
  CapabilityInventorySchema,
  CoverageMatrixSchema,
  LegacyCapabilityExtractSchema,
  OracleExtractResultSchema,
  ResolveResultSchema,
  SelectionLedgerSchema,
  SupportMatrixSchema,
  SurfaceExtractResultSchema,
  TraceReviewMemoSchema,
  auditCapabilityInventory,
  auditSurfaceExtract,
  normalizeLegacyCapabilityExtract,
  type CapabilityExtractResult,
  type CapabilityInventory,
  type ConceptUniverse,
  type CoverageMatrix,
  type FailureTaxonomy,
  type GraderLedger,
  type OracleExtractResult,
  type ResolveResult,
  type SelectionLedger,
  type SuiteMethodology,
  type SupportMatrix,
  type SurfaceExtractResult,
  type TraceReviewMemo,
} from "ax-eval";
import { readContainedText, writeContainedText } from "./artifact-filesystem.js";
import {
  assertCanonicalDaebWritePath,
  daebCapabilityInventoryPath,
  daebLegacyCapabilitiesPath,
  daebOraclesPath,
  daebReadCapabilityInventoryPath,
  daebReadLegacyCapabilitiesPath,
  daebReadOraclesPath,
  daebReadRoot,
  daebReadSurfacesPath,
  daebReadVendorCardPath,
  daebRepositoryRoot,
  daebRoot,
  daebSurfacesPath,
  daebVendorCardPath,
  type DaebPathInput,
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

function readDaebYaml<TSchema extends z.ZodTypeAny>(
  root: DaebPathInput,
  path: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> | null {
  const readRoot = daebReadRoot(root);
  const raw = readContainedText(readRoot, readRoot, path, label);
  return raw === null ? null : parseYaml(raw, path, schema, label);
}

function writeDaebText(root: DaebPathInput, path: string, contents: string, label: string): string {
  const canonical = assertCanonicalDaebWritePath(root, path);
  return writeContainedText(daebRepositoryRoot(root), daebRoot(root), canonical, contents, label);
}

function explicitArtifactPath(root: string, suitePath: string, suffix: string): string {
  return `${resolve(root, suitePath).replace(/\.yaml$/i, "")}${suffix}`;
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

function writeMethodologyArtifact(root: string, path: string, value: unknown, label: string): string {
  const canonical = assertCanonicalDaebWritePath(root, path);
  return writeContainedText(resolve(root), daebRoot(root), canonical, yamlStringify(value), label);
}

export function vendorCardPath(root: DaebPathInput, slug: string): string {
  return daebVendorCardPath(root, slug);
}

export function writeVendorCard(root: DaebPathInput, result: ResolveResult): string {
  return writeDaebText(root, vendorCardPath(root, result.slug), yamlStringify(result), "vendor card");
}

export function loadVendorCard(root: DaebPathInput, slug: string): ResolveResult | null {
  return readDaebYaml(root, daebReadVendorCardPath(root, slug), ResolveResultSchema, "vendor card");
}

export function capabilityInventoryPath(root: DaebPathInput, slug: string): string {
  return daebCapabilityInventoryPath(root, slug);
}

export function legacyCapabilityExtractPath(root: DaebPathInput, slug: string): string {
  return daebLegacyCapabilitiesPath(root, slug);
}

const CAPABILITY_INVENTORY_HEADER = [
  "# Cited capability inventory (suite authoring Layer 0a).",
  "# Each entry's surfaces_documented records which surfaces the official docs say can",
  "# perform that capability - per-capability documentation attribution for coverage",
  "# synthesis, not the same as surfaces.yaml (CLI/SDK/MCP install/auth for the agent).",
  "",
].join("\n");

export function writeCapabilityInventory(root: DaebPathInput, inventory: CapabilityInventory): string {
  return writeDaebText(
    root,
    capabilityInventoryPath(root, inventory.slug),
    `${CAPABILITY_INVENTORY_HEADER}${yamlStringify(auditCapabilityInventory(inventory))}`,
    "capability inventory",
  );
}

export function loadCapabilityInventory(root: DaebPathInput, slug: string): CapabilityInventory | null {
  return readDaebYaml(root, daebReadCapabilityInventoryPath(root, slug), CapabilityInventorySchema, "capability inventory")
    ?? readDaebYaml(root, daebReadLegacyCapabilitiesPath(root, slug), CapabilityInventorySchema, "legacy capability inventory");
}

export function capabilityExtractPath(root: DaebPathInput, slug: string): string {
  return capabilityInventoryPath(root, slug);
}

export function writeCapabilityExtract(root: DaebPathInput, result: CapabilityExtractResult): string {
  return writeCapabilityInventory(root, result);
}

export function loadCapabilityExtract(root: DaebPathInput, slug: string): CapabilityExtractResult | null {
  const inventoryPath = daebReadCapabilityInventoryPath(root, slug);
  const legacyPath = daebReadLegacyCapabilitiesPath(root, slug);
  const inventoryRaw = readContainedText(daebReadRoot(root), daebReadRoot(root), inventoryPath, "capability extract");
  const legacyRaw = readContainedText(daebReadRoot(root), daebReadRoot(root), legacyPath, "legacy capability extract");
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

export function surfaceExtractPath(root: DaebPathInput, slug: string): string {
  return daebSurfacesPath(root, slug);
}

const SURFACE_EXTRACT_HEADER = [
  "# Optional agent surface adapters for exec-plan (CLI / SDK / MCP only).",
  "# REST API is always the implicit default surface and is intentionally omitted here;",
  "# API auth and base URL come from the vendor oracle extract, not this file.",
  "",
].join("\n");

export function writeSurfaceExtract(root: DaebPathInput, result: SurfaceExtractResult): string {
  return writeDaebText(
    root,
    surfaceExtractPath(root, result.slug),
    `${SURFACE_EXTRACT_HEADER}${yamlStringify(auditSurfaceExtract(result))}`,
    "surface extract",
  );
}

export function loadSurfaceExtract(root: DaebPathInput, slug: string): SurfaceExtractResult | null {
  return readDaebYaml(root, daebReadSurfacesPath(root, slug), SurfaceExtractResultSchema, "surface extract");
}

export function oracleExtractPath(root: DaebPathInput, slug: string, _suiteName: string): string {
  return daebOraclesPath(root, slug);
}

export function writeOracleExtract(root: DaebPathInput, result: OracleExtractResult): string {
  return writeDaebText(
    root,
    oracleExtractPath(root, result.slug, result.suite_name),
    yamlStringify(result),
    "oracle extract",
  );
}

export function loadOracleExtract(root: DaebPathInput, slug: string, _suiteName: string): OracleExtractResult | null {
  return readDaebYaml(root, daebReadOraclesPath(root, slug), OracleExtractResultSchema, "oracle extract");
}

export function methodologyPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".methodology.yaml");
}

export function conceptUniversePath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".concept-universe.yaml");
}

export function coverageMatrixPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".coverage-matrix.yaml");
}

export function selectionLedgerPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".selection-ledger.yaml");
}

export function supportMatrixPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".support-matrix.yaml");
}

export function graderLedgerPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".grader-ledger.yaml");
}

export function failureTaxonomyPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".failure-taxonomy.yaml");
}

export function traceReviewPath(root: string, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".trace-review.yaml");
}

export function writeMethodology(root: string, suitePath: string, value: SuiteMethodology): string {
  return writeMethodologyArtifact(root, methodologyPath(root, suitePath), value, "suite methodology");
}

export function writeConceptUniverse(root: string, suitePath: string, value: ConceptUniverse): string {
  return writeMethodologyArtifact(root, conceptUniversePath(root, suitePath), value, "concept universe");
}

export function writeCoverageMatrix(root: string, suitePath: string, value: CoverageMatrix): string {
  return writeMethodologyArtifact(root, coverageMatrixPath(root, suitePath), value, "coverage matrix");
}

export function writeSelectionLedger(root: string, suitePath: string, value: SelectionLedger): string {
  return writeMethodologyArtifact(root, selectionLedgerPath(root, suitePath), value, "selection ledger");
}

export function writeSupportMatrix(root: string, suitePath: string, value: SupportMatrix): string {
  return writeMethodologyArtifact(root, supportMatrixPath(root, suitePath), value, "support matrix");
}

export function writeGraderLedger(root: string, suitePath: string, value: GraderLedger): string {
  return writeMethodologyArtifact(root, graderLedgerPath(root, suitePath), value, "grader ledger");
}

export function writeFailureTaxonomy(root: string, suitePath: string, value: FailureTaxonomy): string {
  return writeMethodologyArtifact(root, failureTaxonomyPath(root, suitePath), value, "failure taxonomy");
}

export function writeTraceReview(root: string, suitePath: string, value: TraceReviewMemo): string {
  return writeMethodologyArtifact(root, traceReviewPath(root, suitePath), value, "trace review");
}

export function loadTraceReview(root: string, suitePath: string): TraceReviewMemo | null {
  return readExplicitYaml(traceReviewPath(root, suitePath), TraceReviewMemoSchema, "trace review");
}

export function loadSupportMatrix(root: string, suitePath: string): SupportMatrix | null {
  return readExplicitYaml(supportMatrixPath(root, suitePath), SupportMatrixSchema, "support matrix");
}

export function loadCoverageMatrix(root: string, suitePath: string): CoverageMatrix | null {
  return readExplicitYaml(coverageMatrixPath(root, suitePath), CoverageMatrixSchema, "coverage matrix");
}

export function loadSelectionLedger(root: string, suitePath: string): SelectionLedger | null {
  return readExplicitYaml(selectionLedgerPath(root, suitePath), SelectionLedgerSchema, "selection ledger");
}
