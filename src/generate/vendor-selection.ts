import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";
import { PublicHttpUrlSchema } from "./public-url.js";

export const VENDOR_SELECTION_LEDGER_SCHEMA = "ax.vendor-selection-ledger/v1" as const;

export const VendorEligibilitySchema = z.object({
  managed_service: z.boolean(),
  persistent_free_sandbox: z.boolean(),
  headless_auth: z.enum(["yes", "no", "unknown"]),
  benchmark_surface: z.enum(["yes", "limited", "no", "unknown"]),
  reset_feasibility: z.enum(["yes", "no", "unknown"]),
}).strict();

export const VendorSelectionEntrySchema = z.object({
  slug: z.string().min(1),
  vendor: z.string().min(1),
  status: z.enum(["core", "research", "excluded"]),
  stratum: z.string().min(1),
  rationale: z.string().min(1),
  eligibility: VendorEligibilitySchema,
  exclusion_reason: z.string().min(1).optional(),
  sources: z.array(PublicHttpUrlSchema).min(1).refine(
    (sources) => new Set(sources).size === sources.length,
    "vendor selection sources must be unique",
  ),
}).strict().superRefine((entry, context) => {
  try {
    assertArtifactSegment(entry.slug, "vendor slug");
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["slug"],
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (entry.status === "excluded" && !entry.exclusion_reason) {
    context.addIssue({ code: "custom", path: ["exclusion_reason"], message: "excluded vendor requires an exclusion reason" });
  }
  if (entry.status !== "excluded" && entry.exclusion_reason) {
    context.addIssue({ code: "custom", path: ["exclusion_reason"], message: "only excluded vendors may declare an exclusion reason" });
  }
  if (entry.status !== "core") return;
  if (!entry.eligibility.managed_service || !entry.eligibility.persistent_free_sandbox) {
    context.addIssue({ code: "custom", path: ["eligibility"], message: "core vendor requires a managed persistent free sandbox" });
  }
  if (entry.eligibility.headless_auth !== "yes" || entry.eligibility.benchmark_surface !== "yes") {
    context.addIssue({ code: "custom", path: ["eligibility"], message: "core vendor requires headless auth and a benchmark surface" });
  }
  if (entry.eligibility.reset_feasibility !== "yes") {
    context.addIssue({ code: "custom", path: ["eligibility", "reset_feasibility"], message: "core vendor requires confirmed reset feasibility" });
  }
});

export const VendorSelectionLedgerSchema = z.object({
  schema: z.literal(VENDOR_SELECTION_LEDGER_SCHEMA),
  benchmark: z.object({
    slug: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  generated_at: z.string().datetime(),
  methodology: z.object({
    sampling: z.literal("purposive-stratified"),
    population: z.string().min(1),
    core_rule: z.string().min(1),
    research_rule: z.string().min(1),
    exclusion_rule: z.string().min(1),
    minimum_core_vendors: z.number().int().positive(),
  }).strict(),
  entries: z.array(VendorSelectionEntrySchema).min(1),
}).strict().superRefine((ledger, context) => {
  for (const [field, value] of Object.entries(ledger.benchmark)) {
    try {
      assertArtifactSegment(value, `benchmark ${field}`);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["benchmark", field],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const slugs = ledger.entries.map((entry) => entry.slug);
  if (new Set(slugs).size !== slugs.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "vendor selection slugs must be unique" });
  }
  const coreCount = ledger.entries.filter((entry) => entry.status === "core").length;
  if (coreCount < ledger.methodology.minimum_core_vendors) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: `vendor ledger requires at least ${ledger.methodology.minimum_core_vendors} core vendors`,
    });
  }
});

export type VendorEligibility = z.infer<typeof VendorEligibilitySchema>;
export type VendorSelectionEntry = z.infer<typeof VendorSelectionEntrySchema>;
export type VendorSelectionLedger = z.infer<typeof VendorSelectionLedgerSchema>;
export type VendorSelectionStatus = VendorSelectionEntry["status"];

export function loadVendorSelectionLedger(path: string): VendorSelectionLedger | null {
  return loadOptionalYamlArtifact(path, VendorSelectionLedgerSchema, "vendor selection ledger");
}

export function vendorSlugsByStatus(
  ledger: VendorSelectionLedger,
  status: VendorSelectionStatus,
): string[] {
  return ledger.entries.filter((entry) => entry.status === status).map((entry) => entry.slug);
}
