import { z } from "zod";

const SurfaceIdSchema = z.enum(["api", "cli", "sdk", "mcp"]);

export const SuiteMethodologySchema = z.object({
  schema: z.literal("ax.suite-methodology/v1"),
  ontology: z.object({
    task: z.string().min(1),
    trial: z.string().min(1),
    grader: z.string().min(1),
    transcript: z.string().min(1),
    outcome: z.string().min(1),
    support_decision: z.string().min(1),
    selection_decision: z.string().min(1),
    suite: z.string().min(1),
    publication_bundle: z.string().min(1),
  }),
  static_ax: z.object({
    label: z.string().min(1),
    dimensions: z.array(z.string().min(1)).min(1),
    notes: z.array(z.string().min(1)).default([]),
  }),
  behavioral: z.object({
    label: z.string().min(1),
    source_of_truth: z.string().min(1),
    notes: z.array(z.string().min(1)).default([]),
  }),
  capability_families: z.array(z.string().min(1)).min(1),
  extraction_requirements: z.array(z.string().min(1)).min(1),
  surface_scope: z.array(SurfaceIdSchema).min(1),
  min_vendor_coverage_pct: z.number().min(0).max(1),
  target_task_count: z.number().int().positive(),
  family_diversity_cap: z.number().int().positive(),
  verifiability_requirement: z.string().min(1),
  difficulty_rubric: z.object({
    L1: z.string().min(1),
    L2: z.string().min(1),
    L3: z.string().min(1),
    L4: z.string().min(1),
  }),
  human_review_checkpoints: z.array(z.string().min(1)).min(1),
});

export type SuiteMethodology = z.infer<typeof SuiteMethodologySchema>;
