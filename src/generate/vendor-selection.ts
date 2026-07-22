import { existsSync, readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { daebReadVendorSelectionLedgerPath, type DaebPathInput } from "./benchmark-paths.js";
import { loadCapabilityExtract } from "./capability-extract.js";
import { loadSurfaceExtract } from "./surface-extract.js";

const EligibilitySchema = z.object({
  managed_service: z.boolean(),
  persistent_free_sandbox: z.boolean(),
  headless_auth: z.enum(["yes", "no", "unknown"]),
  benchmark_surface: z.enum(["yes", "limited", "no", "unknown"]),
  reset_feasibility: z.enum(["yes", "no", "unknown"]),
});

export const VendorSelectionEntrySchema = z.object({
  slug: z.string().min(1),
  vendor: z.string().min(1),
  status: z.enum(["core", "research", "excluded"]),
  stratum: z.string().min(1),
  rationale: z.string().min(1),
  eligibility: EligibilitySchema,
  exclusion_reason: z.string().optional(),
  sources: z.array(z.string().url()).min(1),
});

export const VendorSelectionLedgerSchema = z.object({
  schema: z.literal("ax.vendor-selection-ledger/v1"),
  benchmark: z.literal("DAEB-1"),
  generated_at: z.string().min(1),
  methodology: z.object({
    sampling: z.literal("purposive-stratified"),
    population: z.string().min(1),
    core_rule: z.string().min(1),
    research_rule: z.string().min(1),
    exclusion_rule: z.string().min(1),
  }),
  entries: z.array(VendorSelectionEntrySchema).min(1),
}).superRefine((ledger, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of ledger.entries.entries()) {
    if (seen.has(entry.slug)) {
      ctx.addIssue({ code: "custom", path: ["entries", index, "slug"], message: `duplicate vendor slug ${entry.slug}` });
    }
    seen.add(entry.slug);
    if (entry.status === "core") {
      if (!entry.eligibility.managed_service || !entry.eligibility.persistent_free_sandbox) {
        ctx.addIssue({ code: "custom", path: ["entries", index], message: "core vendor requires managed persistent free sandbox" });
      }
      if (entry.eligibility.headless_auth !== "yes" || entry.eligibility.benchmark_surface !== "yes") {
        ctx.addIssue({ code: "custom", path: ["entries", index], message: "core vendor requires headless auth and benchmark surface" });
      }
    }
    if (entry.status === "excluded" && !entry.exclusion_reason) {
      ctx.addIssue({ code: "custom", path: ["entries", index], message: "excluded vendor requires exclusion_reason" });
    }
  }
  if (ledger.entries.filter((entry) => entry.status === "core").length < 2) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "vendor ledger requires at least two core vendors" });
  }
});

export type VendorSelectionLedger = z.infer<typeof VendorSelectionLedgerSchema>;

export function loadVendorSelectionLedger(root: DaebPathInput): VendorSelectionLedger | null {
  const path = daebReadVendorSelectionLedgerPath(root);
  if (!existsSync(path)) return null;
  return VendorSelectionLedgerSchema.parse(yamlParse(readFileSync(path, "utf8")));
}

export function coreVendorSlugs(root: DaebPathInput): string[] | null {
  const ledger = loadVendorSelectionLedger(root);
  return ledger
    ? ledger.entries.filter((entry) => entry.status === "core").map((entry) => entry.slug)
    : null;
}

export interface VendorSelectionFinding {
  slug: string;
  severity: "error" | "warn";
  code: "core_extract_missing" | "core_headless_cli_missing";
  message: string;
}

/** Verify that a ledger's core claims remain backed by authoring artifacts. */
export function auditVendorSelectionAgainstExtracts(root: DaebPathInput): VendorSelectionFinding[] {
  const ledger = loadVendorSelectionLedger(root);
  if (!ledger) return [];
  const findings: VendorSelectionFinding[] = [];
  for (const entry of ledger.entries.filter((candidate) => candidate.status === "core")) {
      const inventory = loadCapabilityExtract(root, entry.slug);
      const surfaces = loadSurfaceExtract(root, entry.slug);
      if (!inventory || !surfaces) {
        findings.push({
          slug: entry.slug,
          severity: "error",
          code: "core_extract_missing",
          message: `Core vendor ${entry.slug} requires capability inventory and surface extract`,
        });
        continue;
      }
      const headlessCli = surfaces.cli && (
        (surfaces.cli.auth.kind === "token" && Boolean(surfaces.cli.auth.token_env))
        || surfaces.cli.auth.kind === "inherit"
      );
      if (entry.eligibility.headless_auth === "yes" && !headlessCli) {
        findings.push({
          slug: entry.slug,
          severity: "error",
          code: "core_headless_cli_missing",
          message: `Core vendor ${entry.slug} claims headless auth but has no token or inherited-credential CLI surface`,
        });
      }
  }
  return findings;
}
