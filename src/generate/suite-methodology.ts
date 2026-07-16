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

export function defaultSuiteMethodology(category: string, targetTaskCount: number): SuiteMethodology {
  const databaseFamilies = [
    "data-definition",
    "writes",
    "reads",
    "integrity",
    "access-control",
    "migration",
    "operations",
    "recovery",
  ];
  return SuiteMethodologySchema.parse({
    schema: "ax.suite-methodology/v1",
    ontology: {
      task: "A canonical, vendor-neutral user goal.",
      trial: "One isolated task execution for a vendor, surface, harness, and attempt.",
      grader: "A deterministic read-back oracle over live sandbox state.",
      transcript: "The native harness trace retained as execution evidence.",
      outcome: "The verified task result, independent of the executor report.",
      support_decision: "An evidence-backed vendor and surface support classification.",
      selection_decision: "A recorded reason a concept entered or missed the canonical suite.",
      suite: "The frozen category-level task contract shared across vendors.",
      publication_bundle: "The reviewed suite, packs, evidence, trials, and aggregate records.",
    },
    static_ax: {
      label: "Static agent experience",
      dimensions: ["discoverability", "documentation", "machine-readable-contracts"],
      notes: ["Static readiness is reported separately from behavioral task success."],
    },
    behavioral: {
      label: "Behavioral execution",
      source_of_truth: "Independent live-state read-back oracles.",
      notes: ["Executor self-reports never decide task success on their own."],
    },
    capability_families: category === "database" ? databaseFamilies : [category],
    extraction_requirements: [
      "Use official vendor documentation only.",
      "Attach a documentation URL and short evidence quote to every capability.",
      "Keep unsupported or uncertain support decisions explicit; absence is not proof of unsupported behavior.",
    ],
    surface_scope: category === "database" ? ["api", "cli"] : ["api", "cli", "sdk", "mcp"],
    min_vendor_coverage_pct: 0.5,
    target_task_count: targetTaskCount,
    family_diversity_cap: 2,
    verifiability_requirement: "Every selected task needs an independent deterministic read-back oracle.",
    difficulty_rubric: {
      L1: "One direct operation with a single-resource read-back.",
      L2: "A short multi-step operation or filtered-state assertion.",
      L3: "A cross-resource or policy-sensitive workflow with deterministic verification.",
      L4: "A recovery, migration, or operational scenario with multiple dependent state transitions.",
    },
    human_review_checkpoints: [
      "Review capability evidence and concept clustering.",
      "Review selection coverage and family diversity.",
      "Review every composed task, N/A reason, surface, credential declaration, and oracle before approval.",
    ],
  });
}
