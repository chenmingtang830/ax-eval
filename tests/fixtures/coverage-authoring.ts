import type { CapabilityExtractResult } from "../../src/generate/capability-extract.js";
import {
  buildCoverageMatrix,
  deriveConceptUniverse,
  selectCoverageConcepts,
} from "../../src/generate/coverage.js";
import { defaultSuiteMethodology } from "../../src/generate/suite-methodology.js";
import type { Suite } from "../../src/generate/suite.js";

function extract(vendor: string, slug: string): CapabilityExtractResult {
  return {
    vendor,
    slug,
    category: "database",
    extracted_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: [
      { capability_name: "create-table", title: "Create tables" },
      { capability_name: "filtered-read", title: "Query records" },
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

export async function createCoverageAuditArtifacts() {
  const methodology = defaultSuiteMethodology("database", 2);
  const universe = await deriveConceptUniverse("database", [
    extract("Alpha", "alpha"),
    extract("Beta", "beta"),
  ], methodology, { now: () => new Date("2026-07-16T00:00:00.000Z") });
  const selection = selectCoverageConcepts(universe, methodology, () => new Date("2026-07-16T00:01:00.000Z"));
  const matrix = buildCoverageMatrix(universe, () => new Date("2026-07-16T00:02:00.000Z"));
  const suite: Suite = {
    name: "database-eval",
    version: 1,
    category: universe.category,
    methodology,
    tasks: selection.selected.map((concept, index) => ({
      id: `db-T${String(index + 1).padStart(2, "0")}-${concept.concept_name}`,
      title: concept.title,
      difficulty: index === 0 ? "L1" : "L2",
      skill: concept.skill,
      intent: `Complete ${concept.title.toLowerCase()} for ax_{ns}.`,
      oracle_hint: "Read live state back independently.",
      allowed_surfaces: [...methodology.surface_scope],
      na_examples: [],
    })),
  };
  return { universe, selection, matrix, methodology, suite };
}
