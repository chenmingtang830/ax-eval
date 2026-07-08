import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

export const CANONICAL_SURFACE_SCOPE = ["api", "sdk", "cli"] as const;
export const CANONICAL_ARTIFACT_SCHEMA_VERSION = "ax.suite-methodology/v1" as const;
export const CAPABILITY_INVENTORY_SCHEMA_VERSION = "ax.capability-inventory/v1" as const;

const SurfaceIdSchema = z.enum(CANONICAL_SURFACE_SCOPE);

export const OntologySchema = z.object({
  task: z.string().min(1),
  trial: z.string().min(1),
  grader: z.string().min(1),
  transcript: z.string().min(1),
  outcome: z.string().min(1),
  support_decision: z.string().min(1),
  selection_decision: z.string().min(1),
  suite: z.string().min(1),
  publication_bundle: z.string().min(1),
});

export const StaticAxMethodologySchema = z.object({
  label: z.string().min(1),
  dimensions: z.array(z.string().min(1)).min(1),
  notes: z.array(z.string().min(1)).default([]),
});

export const BehavioralMethodologySchema = z.object({
  label: z.string().min(1),
  source_of_truth: z.string().min(1),
  notes: z.array(z.string().min(1)).default([]),
});

export const DifficultyRubricSchema = z.object({
  L1: z.string().min(1),
  L2: z.string().min(1),
  L3: z.string().min(1),
  L4: z.string().min(1),
});

export const SuiteMethodologySchema = z.object({
  schema: z.literal(CANONICAL_ARTIFACT_SCHEMA_VERSION).default(CANONICAL_ARTIFACT_SCHEMA_VERSION),
  ontology: OntologySchema,
  static_ax: StaticAxMethodologySchema,
  behavioral: BehavioralMethodologySchema,
  extraction_requirements: z.array(z.string().min(1)).min(1),
  surface_scope: z.array(SurfaceIdSchema).default([...CANONICAL_SURFACE_SCOPE]),
  min_vendor_coverage_pct: z.number().min(0).max(1),
  target_task_count: z.number().int().positive(),
  verifiability_requirement: z.string().min(1),
  difficulty_rubric: DifficultyRubricSchema,
  human_review_checkpoints: z.array(z.string().min(1)).min(1),
});
export type SuiteMethodology = z.infer<typeof SuiteMethodologySchema>;

export const CapabilityEvidenceSchema = z.object({
  doc_url: z.string().min(1),
  quote: z.string().min(1),
  note: z.string().optional(),
  strength: z.enum(["direct", "derived_from_connection_surface", "summary_index", "marketing_claim", "inferred"]).optional(),
});

export const ExtractionProvenanceSchema = z.object({
  source: z.literal("official-docs"),
  extracted_at: z.string().min(1),
  extractor: z.string().min(1),
});

export const ExtractionContextSchema = z.object({
  mode: z.enum(["openapi-seeded", "grounded-doc-crawl", "manual-review"]),
  harness: z.string().optional(),
  model: z.string().optional(),
  spec_url: z.string().optional(),
  notes: z.string().optional(),
});

export const CapabilityInventoryEntrySchema = z.object({
  capability_name: z.string().min(1),
  title: z.string().min(1),
  family: z.string().optional(),
  description: z.string().min(1),
  resource_kind: z.string().min(1),
  operation_kind: z.string().min(1),
  surfaces_documented: z.array(SurfaceIdSchema).default([...CANONICAL_SURFACE_SCOPE]),
  support_type: z.enum(["native", "idiomatic-pattern", "managed-surface", "unknown"]).default("native"),
  evidence: z.array(CapabilityEvidenceSchema).min(1),
  extraction_provenance: ExtractionProvenanceSchema,
});
export type CapabilityInventoryEntry = z.infer<typeof CapabilityInventoryEntrySchema>;

export const CapabilityInventorySchema = z.object({
  schema: z.literal(CAPABILITY_INVENTORY_SCHEMA_VERSION).default(CAPABILITY_INVENTORY_SCHEMA_VERSION),
  vendor: z.string().min(1),
  slug: z.string().min(1),
  category: z.string().min(1),
  extracted_at: z.string().min(1),
  methodology_ref: z.string().optional(),
  extraction_context: ExtractionContextSchema.optional(),
  audit_status: z.enum(["candidate", "reviewed", "needs-reextract"]).default("candidate"),
  audit_notes: z.array(z.string().min(1)).default([]),
  capabilities: z.array(CapabilityInventoryEntrySchema),
});
export type CapabilityInventory = z.infer<typeof CapabilityInventorySchema>;

export const ConceptCoverageSchema = z.object({
  vendor: z.string().min(1),
  capability_name: z.string().min(1),
});

export const ConceptClusterSchema = z.object({
  concept_name: z.string().min(1),
  title: z.string().min(1),
  coverage: z.array(ConceptCoverageSchema).min(1),
});
export type ConceptCluster = z.infer<typeof ConceptClusterSchema>;

export const ConceptUniverseSchema = z.object({
  schema: z.literal("ax.concept-universe/v1"),
  category: z.string().min(1),
  generated_at: z.string().min(1),
  clusters: z.array(ConceptClusterSchema).min(1),
});
export type ConceptUniverse = z.infer<typeof ConceptUniverseSchema>;

export const CoverageDecisionSchema = z.object({
  concept_name: z.string().min(1),
  vendor: z.string().min(1),
  status: z.enum(["supported", "unsupported", "inconclusive"]),
  source: z.enum(["inventory", "gap-check", "selection-default"]),
  capability_name: z.string().optional(),
  family: z.string().optional(),
  surfaces_documented: z.array(SurfaceIdSchema).optional(),
  evidence: z.array(CapabilityEvidenceSchema).default([]),
  reason: z.string().optional(),
});
export type CoverageDecision = z.infer<typeof CoverageDecisionSchema>;

export const CoverageMatrixSchema = z.object({
  schema: z.literal("ax.coverage-matrix/v1"),
  category: z.string().min(1),
  generated_at: z.string().min(1),
  concepts: z.array(z.object({
    concept_name: z.string().min(1),
    title: z.string().min(1),
    decisions: z.array(CoverageDecisionSchema).min(1),
  })).min(1),
});
export type CoverageMatrix = z.infer<typeof CoverageMatrixSchema>;

export const SelectionLedgerEntrySchema = z.object({
  concept_name: z.string().min(1),
  title: z.string().min(1),
  family: z.string().optional(),
  proposed_difficulty: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  coverage_pct: z.number().min(0).max(1),
  covered_vendors: z.array(z.string().min(1)).min(1),
  verifiable: z.boolean(),
  selected_by_model: z.boolean().default(false),
  selected: z.boolean(),
  rationale: z.string().min(1),
  rejection_reason: z.string().optional(),
});
export type SelectionLedgerEntry = z.infer<typeof SelectionLedgerEntrySchema>;

export const SelectionLedgerSchema = z.object({
  schema: z.literal("ax.selection-ledger/v1"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  generated_at: z.string().min(1),
  methodology: SuiteMethodologySchema,
  entries: z.array(SelectionLedgerEntrySchema).min(1),
});
export type SelectionLedger = z.infer<typeof SelectionLedgerSchema>;

export const SupportMatrixEntrySchema = z.object({
  vendor: z.string().min(1),
  task_id: z.string().min(1),
  surface: SurfaceIdSchema,
  status: z.enum(["supported", "unsupported", "inconclusive"]),
  source_concept: z.string().min(1),
  reason: z.string().optional(),
});
export type SupportMatrixEntry = z.infer<typeof SupportMatrixEntrySchema>;

export const SupportMatrixSchema = z.object({
  schema: z.literal("ax.support-matrix/v1"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  generated_at: z.string().min(1),
  entries: z.array(SupportMatrixEntrySchema).min(1),
});
export type SupportMatrix = z.infer<typeof SupportMatrixSchema>;

export const GraderLedgerEntrySchema = z.object({
  task_id: z.string().min(1),
  outcome_graders: z.array(z.string().min(1)).min(1),
  trajectory_graders: z.array(z.string().min(1)).default([]),
  efficiency_metrics: z.array(z.string().min(1)).default([]),
  human_calibration: z.array(z.string().min(1)).default([]),
});
export type GraderLedgerEntry = z.infer<typeof GraderLedgerEntrySchema>;

export const GraderLedgerSchema = z.object({
  schema: z.literal("ax.grader-ledger/v1"),
  benchmark: z.string().min(1),
  generated_at: z.string().min(1),
  tasks: z.array(GraderLedgerEntrySchema).min(1),
});
export type GraderLedger = z.infer<typeof GraderLedgerSchema>;

export const FailureTaxonomySchema = z.object({
  schema: z.literal("ax.failure-taxonomy/v1"),
  benchmark: z.string().min(1),
  generated_at: z.string().min(1),
  categories: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
  })).min(1),
});
export type FailureTaxonomy = z.infer<typeof FailureTaxonomySchema>;

export const TraceReviewMemoSchema = z.object({
  schema: z.literal("ax.trace-review/v1"),
  benchmark: z.string().min(1),
  generated_at: z.string().min(1),
  sample_size: z.number().int().positive(),
  summary: z.string().min(1),
});
export type TraceReviewMemo = z.infer<typeof TraceReviewMemoSchema>;

export function defaultSuiteMethodology(category: string): SuiteMethodology {
  return SuiteMethodologySchema.parse({
    ontology: {
      task: "A single benchmark problem with fixed intent and success criteria.",
      trial: "One attempt at a task under a clean environment.",
      grader: "Logic that scores either an outcome or transcript-derived property.",
      transcript: "Behavior evidence from the agent run, including tool use and intermediate steps.",
      outcome: "Final world state in the environment after a trial.",
      support_decision: "A recorded judgment about whether a vendor/surface can perform a task.",
      selection_decision: "A recorded judgment about whether a concept becomes part of the canonical suite.",
      suite: "The frozen canonical task bank for a category.",
      publication_bundle: "The artifact bundle tying methodology, adapters, evidence, and results together.",
    },
    static_ax: {
      label: "Discoverability & Readiness",
      dimensions: ["discoverability", "content quality", "capability exposure", "protocol/access readiness"],
      notes: [
        "Discoverability & Readiness is a publication/audit layer and never changes usability-suite pass rates.",
      ],
    },
    behavioral: {
      label: "Usability Canonical Suite",
      source_of_truth: "Verified world state read back from the live product",
      notes: [
        "Usability-suite scoring is governed only by verified task outcomes on the suite-declared benchmark surfaces.",
      ],
    },
    extraction_requirements: [
      "Use only official vendor documentation as evidence.",
      "Persist every extracted capability with structured evidence objects.",
      "Document supported benchmark surfaces where evidence exists; deferred surfaces may still be retained as research metadata.",
    ],
    min_vendor_coverage_pct: 0.75,
    target_task_count: 10,
    verifiability_requirement: "Selected tasks must have deterministic read-back verification against world state.",
    difficulty_rubric: {
      L1: "Single action: one create/read/update/check call with minimal setup.",
      L2: "Single capability with configuration or composition: ACL, vector search index, etc.",
      L3: "Multi-step workflow within one domain: schema evolution, server-side routine.",
      L4: "Full lifecycle or cross-cutting operational workflow: backup/restore, CDC, integrity constraints.",
    },
    human_review_checkpoints: [
      "bottom-up pipeline review: capability inventory → concept universe → coverage matrix → selection ledger → task drafts",
      "final suite freeze",
      "publication bundle release",
    ],
  });
}

function readYaml<TSchema extends z.ZodTypeAny>(path: string, schema: TSchema): z.infer<TSchema> | null {
  if (!existsSync(path)) return null;
  const parsed = yamlParse(readFileSync(path, "utf8"));
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Malformed methodology artifact at ${path}: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}

function writeYaml(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(value));
  return path;
}

export function capabilityInventoryPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", slug, "capability-inventory.yaml");
}

export function legacyCapabilityExtractPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", slug, "capabilities.yaml");
}

export function loadCapabilityInventory(root: string, slug: string): CapabilityInventory | null {
  return readYaml(capabilityInventoryPath(root, slug), CapabilityInventorySchema)
    ?? readYaml(legacyCapabilityExtractPath(root, slug), CapabilityInventorySchema);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function evidenceText(evidence: z.infer<typeof CapabilityEvidenceSchema>): string {
  return `${evidence.doc_url} ${evidence.quote} ${evidence.note ?? ""}`.toLowerCase();
}

function inferEvidenceStrength(evidence: z.infer<typeof CapabilityEvidenceSchema>): NonNullable<z.infer<typeof CapabilityEvidenceSchema>["strength"]> {
  if (evidence.strength) return evidence.strength;
  const url = evidence.doc_url.toLowerCase();
  const text = evidenceText(evidence);
  if (url.endsWith("/llms.txt") || url.includes("/llms.txt")) return "summary_index";
  if (/\/(products?|pricing|features?)\/?$/.test(new URL(evidence.doc_url, "https://example.invalid").pathname)) return "marketing_claim";
  if (
    /(connection[-_\s]?string|connection uri|wire protocol|sql surface|postgresql-compatible|mongodb driver|any mongodb driver)/i.test(text)
    && /(cluster|connection|deployment|project)/i.test(evidence.quote)
  ) {
    return "derived_from_connection_surface";
  }
  if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(evidence.quote)) return "direct";
  if (/\b(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|UPSERT|BEGIN|COMMIT|ROLLBACK)\b/i.test(evidence.quote)) return "direct";
  if (/\b(insertOne|insertMany|findOne|find|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|aggregate|watch|createCollection)\b/.test(evidence.quote)) {
    return "direct";
  }
  return "inferred";
}

function isConnectionDerivedDataPlane(capability: CapabilityInventoryEntry): boolean {
  const text = capability.evidence.map(evidenceText).join(" ");
  return /(connection[-_\s]?string|connection uri|wire protocol|postgresql-compatible|mongodb driver|any mongodb driver)/i.test(text)
    && capability.surfaces_documented.includes("api")
    && (capability.surfaces_documented.includes("sdk") || capability.surfaces_documented.includes("cli"));
}

export function auditCapabilityInventory(inventory: CapabilityInventory): CapabilityInventory {
  const auditNotes = [...(inventory.audit_notes ?? [])];
  let weakEvidenceCount = 0;
  let dataPlaneDowngradeCount = 0;
  let summaryIndexCount = 0;

  const capabilities = inventory.capabilities.map((capability) => {
    const evidence = capability.evidence.map((item) => ({
      ...item,
      strength: inferEvidenceStrength(item),
    }));
    if (evidence.some((item) => item.strength !== "direct")) weakEvidenceCount++;
    if (evidence.some((item) => item.strength === "summary_index")) summaryIndexCount++;

    let surfacesDocumented = [...capability.surfaces_documented];
    let supportType = capability.support_type;
    const allEvidenceWeak = evidence.every((item) => item.strength !== "direct");
    const connectionDerived = isConnectionDerivedDataPlane({ ...capability, evidence });

    if (connectionDerived) {
      surfacesDocumented = surfacesDocumented.filter((surface) => surface !== "api");
      dataPlaneDowngradeCount++;
    }
    if (supportType === "native" && allEvidenceWeak) {
      supportType = evidence.some((item) => item.strength === "marketing_claim") ? "unknown" : "idiomatic-pattern";
    }

    return {
      ...capability,
      surfaces_documented: uniq(surfacesDocumented),
      support_type: supportType,
      evidence,
      extraction_provenance: {
        ...capability.extraction_provenance,
        extracted_at: capability.extraction_provenance.extracted_at === "2026-01-01T00:00:00.000Z"
          ? inventory.extracted_at
          : capability.extraction_provenance.extracted_at,
      },
    };
  });

  if (weakEvidenceCount) {
    auditNotes.push(`${weakEvidenceCount} capabilities include non-direct evidence and require reviewer confirmation before publication.`);
  }
  if (dataPlaneDowngradeCount) {
    auditNotes.push(`${dataPlaneDowngradeCount} connection-derived data-plane capabilities were removed from REST api attribution and downgraded unless directly cited.`);
  }
  if (summaryIndexCount) {
    auditNotes.push(`${summaryIndexCount} capabilities cite summary-index evidence such as llms.txt; replace with page-specific docs before publication.`);
  }

  return CapabilityInventorySchema.parse({
    ...inventory,
    schema: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    audit_status: inventory.audit_status ?? "candidate",
    audit_notes: uniq(auditNotes),
    capabilities,
  });
}

const CAPABILITY_INVENTORY_HEADER = [
  "# Cited capability inventory (suite authoring Layer 0a).",
  "# Each entry's surfaces_documented records which surfaces the official docs say can",
  "# perform that capability - per-capability documentation attribution for coverage",
  "# synthesis, not the same as surfaces.yaml (CLI/SDK/MCP install/auth for the agent).",
  "",
].join("\n");

export function writeCapabilityInventory(root: string, inventory: CapabilityInventory): string {
  const path = capabilityInventoryPath(root, inventory.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${CAPABILITY_INVENTORY_HEADER}${yamlStringify(auditCapabilityInventory(inventory))}`);
  return path;
}

function suiteStemPath(root: string, suitePath: string): string {
  return resolve(root, suitePath).replace(/\.yaml$/i, "");
}

export function methodologyPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.methodology.yaml`;
}

export function conceptUniversePath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.concept-universe.yaml`;
}

export function coverageMatrixPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.coverage-matrix.yaml`;
}

export function selectionLedgerPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.selection-ledger.yaml`;
}

export function supportMatrixPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.support-matrix.yaml`;
}

export function graderLedgerPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.grader-ledger.yaml`;
}

export function failureTaxonomyPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.failure-taxonomy.yaml`;
}

export function traceReviewPath(root: string, suitePath: string): string {
  return `${suiteStemPath(root, suitePath)}.trace-review.yaml`;
}

export function writeMethodology(root: string, suitePath: string, methodology: SuiteMethodology): string {
  return writeYaml(methodologyPath(root, suitePath), methodology);
}

export function writeConceptUniverse(root: string, suitePath: string, artifact: ConceptUniverse): string {
  return writeYaml(conceptUniversePath(root, suitePath), artifact);
}

export function writeCoverageMatrix(root: string, suitePath: string, artifact: CoverageMatrix): string {
  return writeYaml(coverageMatrixPath(root, suitePath), artifact);
}

export function writeSelectionLedger(root: string, suitePath: string, artifact: SelectionLedger): string {
  return writeYaml(selectionLedgerPath(root, suitePath), artifact);
}

export function writeSupportMatrix(root: string, suitePath: string, artifact: SupportMatrix): string {
  return writeYaml(supportMatrixPath(root, suitePath), artifact);
}

export function writeGraderLedger(root: string, suitePath: string, artifact: GraderLedger): string {
  return writeYaml(graderLedgerPath(root, suitePath), artifact);
}

export function writeFailureTaxonomy(root: string, suitePath: string, artifact: FailureTaxonomy): string {
  return writeYaml(failureTaxonomyPath(root, suitePath), artifact);
}

export function writeTraceReview(root: string, suitePath: string, artifact: TraceReviewMemo): string {
  return writeYaml(traceReviewPath(root, suitePath), artifact);
}

export function loadSupportMatrix(root: string, suitePath: string): SupportMatrix | null {
  return readYaml(supportMatrixPath(root, suitePath), SupportMatrixSchema);
}
