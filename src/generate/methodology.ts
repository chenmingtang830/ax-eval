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
  mode: z.enum([
    "openapi-seeded-grounded",
    /** @deprecated Prefer openapi-seeded-grounded; kept for reading older inventories. */
    "openapi-seeded",
    "grounded-doc-crawl",
    "manual-review",
  ]),
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
