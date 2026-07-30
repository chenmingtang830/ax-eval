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
  assertCanonicalAxArenaDatabaseWritePath,
  axArenaDatabaseCapabilityInventoryPath,
  axArenaDatabaseLegacyCapabilitiesPath,
  axArenaDatabaseOraclesPath,
  axArenaDatabaseReadCapabilityInventoryPath,
  axArenaDatabaseReadLegacyCapabilitiesPath,
  axArenaDatabaseReadOraclesPath,
  axArenaDatabaseReadRoot,
  axArenaDatabaseReadSurfacesPath,
  axArenaDatabaseReadVendorCardPath,
  axArenaDatabaseRepositoryRoot,
  axArenaDatabaseRoot,
  axArenaDatabaseSurfacesPath,
  axArenaDatabaseVendorCardPath,
  type AxArenaDatabasePathInput,
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

function readAxArenaDatabaseYaml<TSchema extends z.ZodTypeAny>(
  root: AxArenaDatabasePathInput,
  path: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> | null {
  const readRoot = axArenaDatabaseReadRoot(root);
  const raw = readContainedText(readRoot, readRoot, path, label);
  return raw === null ? null : parseYaml(raw, path, schema, label);
}

function writeAxArenaDatabaseText(root: AxArenaDatabasePathInput, path: string, contents: string, label: string): string {
  const canonical = assertCanonicalAxArenaDatabaseWritePath(root, path);
  return writeContainedText(axArenaDatabaseRepositoryRoot(root), axArenaDatabaseRoot(root), canonical, contents, label);
}

function explicitArtifactPath(root: AxArenaDatabasePathInput, suitePath: string, suffix: string): string {
  return `${resolve(axArenaDatabaseRepositoryRoot(root), suitePath).replace(/\.yaml$/i, "")}${suffix}`;
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

function writeMethodologyArtifact(root: AxArenaDatabasePathInput, path: string, value: unknown, label: string): string {
  const canonical = assertCanonicalAxArenaDatabaseWritePath(root, path);
  return writeContainedText(axArenaDatabaseRepositoryRoot(root), axArenaDatabaseRoot(root), canonical, yamlStringify(value), label);
}

export function vendorCardPath(root: AxArenaDatabasePathInput, slug: string): string {
  return axArenaDatabaseVendorCardPath(root, slug);
}

export function writeVendorCard(root: AxArenaDatabasePathInput, result: ResolveResult): string {
  return writeAxArenaDatabaseText(root, vendorCardPath(root, result.slug), yamlStringify(result), "vendor card");
}

export function loadVendorCard(root: AxArenaDatabasePathInput, slug: string): ResolveResult | null {
  return readAxArenaDatabaseYaml(root, axArenaDatabaseReadVendorCardPath(root, slug), ResolveResultSchema, "vendor card");
}

export function capabilityInventoryPath(root: AxArenaDatabasePathInput, slug: string): string {
  return axArenaDatabaseCapabilityInventoryPath(root, slug);
}

export function legacyCapabilityExtractPath(root: AxArenaDatabasePathInput, slug: string): string {
  return axArenaDatabaseLegacyCapabilitiesPath(root, slug);
}

const CAPABILITY_INVENTORY_HEADER = [
  "# Cited capability inventory (suite authoring Layer 0a).",
  "# Each entry's surfaces_documented records which surfaces the official docs say can",
  "# perform that capability - per-capability documentation attribution for coverage",
  "# synthesis, not the same as surfaces.yaml (CLI/SDK/MCP install/auth for the agent).",
  "",
].join("\n");

export function writeCapabilityInventory(root: AxArenaDatabasePathInput, inventory: CapabilityInventory): string {
  return writeAxArenaDatabaseText(
    root,
    capabilityInventoryPath(root, inventory.slug),
    `${CAPABILITY_INVENTORY_HEADER}${yamlStringify(auditCapabilityInventory(inventory))}`,
    "capability inventory",
  );
}

export function loadCapabilityInventory(root: AxArenaDatabasePathInput, slug: string): CapabilityInventory | null {
  return readAxArenaDatabaseYaml(root, axArenaDatabaseReadCapabilityInventoryPath(root, slug), CapabilityInventorySchema, "capability inventory")
    ?? readAxArenaDatabaseYaml(root, axArenaDatabaseReadLegacyCapabilitiesPath(root, slug), CapabilityInventorySchema, "legacy capability inventory");
}

export function capabilityExtractPath(root: AxArenaDatabasePathInput, slug: string): string {
  return capabilityInventoryPath(root, slug);
}

export function writeCapabilityExtract(root: AxArenaDatabasePathInput, result: CapabilityExtractResult): string {
  return writeCapabilityInventory(root, result);
}

export function loadCapabilityExtract(root: AxArenaDatabasePathInput, slug: string): CapabilityExtractResult | null {
  const inventoryPath = axArenaDatabaseReadCapabilityInventoryPath(root, slug);
  const legacyPath = axArenaDatabaseReadLegacyCapabilitiesPath(root, slug);
  const inventoryRaw = readContainedText(axArenaDatabaseReadRoot(root), axArenaDatabaseReadRoot(root), inventoryPath, "capability extract");
  const legacyRaw = readContainedText(axArenaDatabaseReadRoot(root), axArenaDatabaseReadRoot(root), legacyPath, "legacy capability extract");
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

export function surfaceExtractPath(root: AxArenaDatabasePathInput, slug: string): string {
  return axArenaDatabaseSurfacesPath(root, slug);
}

const SURFACE_EXTRACT_HEADER = [
  "# Optional agent surface adapters for exec-plan (CLI / SDK / MCP only).",
  "# REST API is always the implicit default surface and is intentionally omitted here;",
  "# API auth and base URL come from the vendor oracle extract, not this file.",
  "",
].join("\n");

export function writeSurfaceExtract(root: AxArenaDatabasePathInput, result: SurfaceExtractResult): string {
  return writeAxArenaDatabaseText(
    root,
    surfaceExtractPath(root, result.slug),
    `${SURFACE_EXTRACT_HEADER}${yamlStringify(auditSurfaceExtract(result))}`,
    "surface extract",
  );
}

export function loadSurfaceExtract(root: AxArenaDatabasePathInput, slug: string): SurfaceExtractResult | null {
  return readAxArenaDatabaseYaml(root, axArenaDatabaseReadSurfacesPath(root, slug), SurfaceExtractResultSchema, "surface extract");
}

export function oracleExtractPath(root: AxArenaDatabasePathInput, slug: string, _suiteName: string): string {
  return axArenaDatabaseOraclesPath(root, slug);
}

export function writeOracleExtract(root: AxArenaDatabasePathInput, result: OracleExtractResult): string {
  return writeAxArenaDatabaseText(
    root,
    oracleExtractPath(root, result.slug, result.suite_name),
    yamlStringify(result),
    "oracle extract",
  );
}

export function loadOracleExtract(root: AxArenaDatabasePathInput, slug: string, _suiteName: string): OracleExtractResult | null {
  return readAxArenaDatabaseYaml(root, axArenaDatabaseReadOraclesPath(root, slug), OracleExtractResultSchema, "oracle extract");
}

export function methodologyPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".methodology.yaml");
}

export function conceptUniversePath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".concept-universe.yaml");
}

export function coverageMatrixPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".coverage-matrix.yaml");
}

export function selectionLedgerPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".selection-ledger.yaml");
}

export function supportMatrixPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".support-matrix.yaml");
}

export function graderLedgerPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".grader-ledger.yaml");
}

export function failureTaxonomyPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".failure-taxonomy.yaml");
}

export function traceReviewPath(root: AxArenaDatabasePathInput, suitePath: string): string {
  return explicitArtifactPath(root, suitePath, ".trace-review.yaml");
}

export function writeMethodology(root: AxArenaDatabasePathInput, suitePath: string, value: SuiteMethodology): string {
  return writeMethodologyArtifact(root, methodologyPath(root, suitePath), value, "suite methodology");
}

export function writeConceptUniverse(root: AxArenaDatabasePathInput, suitePath: string, value: ConceptUniverse): string {
  return writeMethodologyArtifact(root, conceptUniversePath(root, suitePath), value, "concept universe");
}

export function writeCoverageMatrix(root: AxArenaDatabasePathInput, suitePath: string, value: CoverageMatrix): string {
  return writeMethodologyArtifact(root, coverageMatrixPath(root, suitePath), value, "coverage matrix");
}

export function writeSelectionLedger(root: AxArenaDatabasePathInput, suitePath: string, value: SelectionLedger): string {
  return writeMethodologyArtifact(root, selectionLedgerPath(root, suitePath), value, "selection ledger");
}

export function writeSupportMatrix(root: AxArenaDatabasePathInput, suitePath: string, value: SupportMatrix): string {
  return writeMethodologyArtifact(root, supportMatrixPath(root, suitePath), value, "support matrix");
}

export function writeGraderLedger(root: AxArenaDatabasePathInput, suitePath: string, value: GraderLedger): string {
  return writeMethodologyArtifact(root, graderLedgerPath(root, suitePath), value, "grader ledger");
}

export function writeFailureTaxonomy(root: AxArenaDatabasePathInput, suitePath: string, value: FailureTaxonomy): string {
  return writeMethodologyArtifact(root, failureTaxonomyPath(root, suitePath), value, "failure taxonomy");
}

export function writeTraceReview(root: AxArenaDatabasePathInput, suitePath: string, value: TraceReviewMemo): string {
  return writeMethodologyArtifact(root, traceReviewPath(root, suitePath), value, "trace review");
}

export function loadTraceReview(root: AxArenaDatabasePathInput, suitePath: string): TraceReviewMemo | null {
  return readExplicitYaml(traceReviewPath(root, suitePath), TraceReviewMemoSchema, "trace review");
}

export function loadSupportMatrix(root: AxArenaDatabasePathInput, suitePath: string): SupportMatrix | null {
  return readExplicitYaml(supportMatrixPath(root, suitePath), SupportMatrixSchema, "support matrix");
}

export function loadCoverageMatrix(root: AxArenaDatabasePathInput, suitePath: string): CoverageMatrix | null {
  return readExplicitYaml(coverageMatrixPath(root, suitePath), CoverageMatrixSchema, "coverage matrix");
}

export function loadSelectionLedger(root: AxArenaDatabasePathInput, suitePath: string): SelectionLedger | null {
  return readExplicitYaml(selectionLedgerPath(root, suitePath), SelectionLedgerSchema, "selection ledger");
}
