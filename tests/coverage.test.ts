import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import {
  ConceptUniverseSchema,
  deriveConceptUniverse,
  buildCoverageMatrix,
  loadConceptUniverse,
  loadConceptUniversePath,
  loadCoverageMatrix,
  loadCoverageMatrixPath,
  loadCoverageSelection,
  loadCoverageSelectionPath,
  selectCoverageConcepts,
  writeConceptUniverse,
  writeCoverageMatrix,
  writeCoverageSelection,
} from "../src/generate/coverage.js";
import { defaultSuiteMethodology } from "../src/generate/suite-methodology.js";

function extract(vendor: string, slug: string, capabilities: Array<{ name: string; family: string }>): CapabilityExtractResult {
  return {
    vendor,
    slug,
    category: "database",
    extracted_at: "2026-01-01T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: capabilities.map((capability) => ({
      capability_name: capability.name,
      title: capability.name.replace(/-/g, " "),
      family: capability.family,
      description: `${capability.name} capability`,
      resource_kind: "table",
      operation_kind: "operate",
      surfaces_documented: ["api"],
      support_type: "native",
      evidence: [{ doc_url: `https://docs.${slug}.example/${capability.name}`, quote: "Official capability." }],
    })),
  };
}

const extracts = [
  extract("AlphaDB", "alpha", [
    { name: "create-table", family: "data-definition" },
    { name: "filtered-read", family: "reads" },
    { name: "backup", family: "recovery" },
  ]),
  extract("BetaDB", "beta", [
    { name: "create-table", family: "data-definition" },
    { name: "filtered-read", family: "reads" },
  ]),
];

describe("coverage methodology", () => {
  it("derives a deterministic evidence-complete concept universe", async () => {
    const methodology = { ...defaultSuiteMethodology("database", 2), family_diversity_cap: 1 };
    const universe = await deriveConceptUniverse("database", extracts, methodology, {
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(universe.method).toBe("deterministic");
    expect(universe.clusters.map((cluster) => cluster.skill)).toEqual([
      "create-table",
      "filtered-read",
      "backup",
    ]);
    expect(universe.clusters.find((cluster) => cluster.concept_name === "create-table")?.vendor_coverage).toBe(1);
    expect(universe.clusters.find((cluster) => cluster.concept_name === "backup")?.vendor_coverage).toBe(0.5);
    const selection = selectCoverageConcepts(universe, methodology, () => new Date("2026-01-03T00:00:00.000Z"));
    expect(selection.selected.map((concept) => concept.concept_name)).toEqual(["create-table", "filtered-read"]);
    expect(selection.selected.map((concept) => concept.skill)).toEqual(["create-table", "filtered-read"]);
    const matrix = buildCoverageMatrix(universe, () => new Date("2026-01-03T00:00:00.000Z"));
    expect(matrix.decisions.find((decision) => decision.slug === "beta" && decision.concept_name === "backup"))
      .toMatchObject({ status: "unknown", evidence_urls: [] });
  });

  it("requires generator clustering to exactly partition known members", async () => {
    const methodology = defaultSuiteMethodology("database", 1);
    await expect(deriveConceptUniverse("database", extracts, methodology, {
      generate: async () => JSON.stringify({
        clusters: [{
          concept_name: "tables",
          title: "Tables",
          family: "data-definition",
          member_ids: ["alpha:create-table", "invented:member"],
        }],
      }),
    })).rejects.toThrow(/unknown member|omitted members/);
  });

  it("rejects malformed persisted universes", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    const universe = await deriveConceptUniverse("database", extracts, methodology);
    const malformed = {
      ...universe,
      clusters: universe.clusters.map((cluster, index) => index === 0
        ? { ...cluster, member_ids: [...cluster.member_ids, cluster.member_ids[0]!] }
        : cluster),
    };
    expect(ConceptUniverseSchema.safeParse(malformed).success).toBe(false);
  });

  it("fails loudly when policy cannot fill the target task count", async () => {
    const methodology = { ...defaultSuiteMethodology("database", 3), min_vendor_coverage_pct: 1 };
    const universe = await deriveConceptUniverse("database", extracts, methodology);
    expect(() => selectCoverageConcepts(universe, methodology)).toThrow(/selected 2 concepts/);
  });

  it("writes and reloads validated artifacts atomically", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    const universe = await deriveConceptUniverse("database", extracts, methodology);
    const selection = selectCoverageConcepts(universe, methodology);
    const matrix = buildCoverageMatrix(universe);
    const root = mkdtempSync(join(tmpdir(), "ax-eval-coverage-"));
    try {
      writeConceptUniverse(root, "daeb-1-v3", universe);
      writeCoverageSelection(root, "daeb-1-v3", selection);
      writeCoverageMatrix(root, "daeb-1-v3", matrix);
      expect(loadConceptUniverse(root, "daeb-1-v3")).toEqual(universe);
      expect(loadCoverageSelection(root, "daeb-1-v3")).toEqual(selection);
      expect(loadCoverageMatrix(root, "daeb-1-v3")).toEqual(matrix);
      expect(loadConceptUniversePath(join(root, "targets", "suites", "daeb-1-v3.concepts.yaml"))).toEqual(universe);
      expect(loadCoverageSelectionPath(join(root, "targets", "suites", "daeb-1-v3.selection.yaml"))).toEqual(selection);
      expect(loadCoverageMatrixPath(join(root, "targets", "suites", "daeb-1-v3.coverage.yaml"))).toEqual(matrix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for missing explicit artifact paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-eval-coverage-loaders-"));
    try {
      expect(loadConceptUniversePath(join(root, "missing-concepts.yaml"))).toBeNull();
      expect(loadCoverageSelectionPath(join(root, "missing-selection.yaml"))).toBeNull();
      expect(loadCoverageMatrixPath(join(root, "missing-matrix.yaml"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels malformed and schema-invalid explicit artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-eval-coverage-loaders-"));
    try {
      const malformedPath = join(root, "concepts.yaml");
      const invalidPath = join(root, "selection.yaml");
      writeFileSync(malformedPath, "clusters: [");
      writeFileSync(invalidPath, "category: database\n");

      expect(() => loadConceptUniversePath(malformedPath)).toThrow(
        `Invalid concept universe at ${malformedPath}: malformed YAML`,
      );
      expect(() => loadCoverageSelectionPath(invalidPath)).toThrow(
        `Invalid coverage selection at ${invalidPath}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
