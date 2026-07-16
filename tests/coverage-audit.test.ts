import { describe, expect, it } from "vitest";
import {
  buildCoverageMatrix,
  deriveConceptUniverse,
  selectCoverageConcepts,
} from "../src/generate/coverage.js";
import { auditCoverageArtifacts } from "../src/generate/coverage-audit.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import { defaultSuiteMethodology } from "../src/generate/suite-methodology.js";

function extract(vendor: string, slug: string): CapabilityExtractResult {
  return {
    vendor,
    slug,
    category: "database",
    extracted_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: [
      { capability_name: "create-table", title: "Create tables", family: "data-definition" },
      { capability_name: "filtered-read", title: "Query records", family: "reads" },
    ].map((capability) => ({
      ...capability,
      description: "Operate on database records.",
      resource_kind: "record",
      operation_kind: capability.capability_name === "create-table" ? "create" : "read",
      surfaces_documented: ["api"] as const,
      support_type: "native" as const,
      evidence: [{
        doc_url: `https://docs.${slug}.example/${capability.capability_name}`,
        quote: `${vendor} documents ${capability.capability_name}.`,
      }],
    })),
  };
}

async function artifacts() {
  const methodology = defaultSuiteMethodology("database", 2);
  const universe = await deriveConceptUniverse("database", [
    extract("Alpha", "alpha"),
    extract("Beta", "beta"),
  ], methodology, { now: () => new Date("2026-07-16T00:00:00.000Z") });
  const selection = selectCoverageConcepts(universe, methodology, () => new Date("2026-07-16T00:01:00.000Z"));
  const matrix = buildCoverageMatrix(universe, () => new Date("2026-07-16T00:02:00.000Z"));
  return { universe, selection, matrix, methodology };
}

describe("auditCoverageArtifacts", () => {
  it("accepts artifacts derived from one reviewed universe and methodology", async () => {
    const input = await artifacts();
    input.selection.selected[0] = {
      rationale: input.selection.selected[0]!.rationale,
      vendor_coverage: input.selection.selected[0]!.vendor_coverage,
      family: input.selection.selected[0]!.family,
      title: input.selection.selected[0]!.title,
      concept_name: input.selection.selected[0]!.concept_name,
    };
    expect(auditCoverageArtifacts(input)).toEqual([]);
  });

  it("detects persisted selection policy drift", async () => {
    const input = await artifacts();
    input.selection.selected[0] = { ...input.selection.selected[0]!, title: "Changed title" };
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({ code: "coverage_selection_policy_drift" }),
    ]);
  });

  it("detects persisted matrix decision drift", async () => {
    const input = await artifacts();
    input.matrix.decisions = input.matrix.decisions.slice(1);
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({ code: "coverage_matrix_decision_drift" }),
    ]);
  });

  it("reports category drift without duplicating it as content drift", async () => {
    const input = await artifacts();
    input.selection.category = "search";
    input.matrix.category = "search";
    expect(auditCoverageArtifacts(input).map((finding) => finding.code)).toEqual([
      "coverage_selection_category_drift",
      "coverage_matrix_category_drift",
    ]);
  });

  it("fails closed when methodology and universe no longer compose", async () => {
    const input = await artifacts();
    const firstCluster = input.universe.clusters[0]!;
    input.methodology = {
      ...input.methodology,
      capability_families: input.methodology.capability_families.filter((family) => family !== firstCluster.family),
      target_task_count: 3,
    };
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({
        code: "coverage_family_scope_drift",
        concept_name: firstCluster.concept_name,
        family: firstCluster.family,
      }),
      expect.objectContaining({ code: "coverage_selection_policy_unresolvable" }),
    ]);
  });
});
