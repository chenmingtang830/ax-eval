import {
  CANONICAL_SURFACE_SCOPE,
  CapabilityEvidenceSchema,
  SuiteMethodologySchema,
} from "ax-eval";
import { z } from "zod";

const SurfaceIdSchema = z.enum(CANONICAL_SURFACE_SCOPE);

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
  concept_capability_name: z.string().optional(),
  candidate_capabilities: z.array(z.object({
    capability_name: z.string().min(1),
    matched_requirements: z.array(z.string().min(1)).default([]),
    fit_score: z.number().nonnegative(),
    surfaces_documented: z.array(SurfaceIdSchema).default([]),
    surface_notes: z.array(z.string().min(1)).default([]),
    evidence: z.array(CapabilityEvidenceSchema).default([]),
  })).optional(),
  capability_bundle: z.array(z.string().min(1)).optional(),
  task_fit: z.object({
    status: z.enum(["sufficient", "insufficient"]),
    requirement_path: z.string().optional(),
    matched_requirements: z.array(z.string().min(1)).default([]),
    missing_requirements: z.array(z.string().min(1)).default([]),
    supported_surfaces: z.array(SurfaceIdSchema).default([]),
    reason: z.string().optional(),
  }).optional(),
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
  task_fit_coverage_pct: z.number().min(0).max(1).default(0),
  task_fit_vendors: z.array(z.string().min(1)).default([]),
  verifier_ready: z.boolean().default(false),
  tier: z.enum(["core", "research", "excluded"]).default("excluded"),
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
  status: z.enum(["pending", "completed"]).default("pending"),
  sample_size: z.number().int().positive(),
  sample_ids: z.array(z.string().min(1)).default([]),
  reviewer: z.string().min(1).optional(),
  reviewed_at: z.string().min(1).optional(),
  commit_sha: z.string().min(7).optional(),
  findings: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1),
}).superRefine((memo, ctx) => {
  if (memo.status !== "completed") return;
  if (!memo.reviewer) ctx.addIssue({ code: "custom", message: "completed trace review requires reviewer" });
  if (!memo.reviewed_at) ctx.addIssue({ code: "custom", message: "completed trace review requires reviewed_at" });
  if (!memo.commit_sha) ctx.addIssue({ code: "custom", message: "completed trace review requires commit_sha" });
  if (memo.sample_ids.length !== memo.sample_size) {
    ctx.addIssue({
      code: "custom",
      message: `completed trace review requires exactly sample_size (${memo.sample_size}) sample_ids`,
    });
  }
});
export type TraceReviewMemo = z.infer<typeof TraceReviewMemoSchema>;
