import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CapabilityInventorySchema,
} from "ax-eval";
import { SupportMatrixSchema } from "../src/authoring/artifact-contracts.js";
import { defaultSuiteMethodology } from "../src/authoring/methodology-policy.js";
import {
  coverageMatrixPath,
  loadSupportMatrix,
  loadCapabilityExtract,
  methodologyPath,
  selectionLedgerPath,
  supportMatrixPath,
  traceReviewPath,
  writeCapabilityInventory,
  writeCoverageMatrix,
  writeFailureTaxonomy,
  writeGraderLedger,
  writeMethodology,
  writeSelectionLedger,
  writeSupportMatrix,
  writeTraceReview,
} from "../src/authoring/artifact-persistence.js";
import { createDaebPathContext } from "../src/authoring/benchmark-paths.js";

describe("arena artifact persistence", () => {
  it("writes capability inventory and support matrix artifacts", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-"));
    try {
      const inventoryPath = writeCapabilityInventory(dir, CapabilityInventorySchema.parse({
        vendor: "Acme",
        slug: "acme",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [{
          capability_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          description: "Tracked schema changes.",
          resource_kind: "table",
          operation_kind: "migrate",
          surfaces_documented: ["api", "cli"],
          support_type: "native",
          evidence: [{ doc_url: "https://docs.example/migrate", quote: "Run tracked migrations." }],
          extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
        }],
      }));
      expect(inventoryPath).toContain("capability-inventory.yaml");
      expect(readdirSync(resolve(dir, "ax-arena", "benchmark", "daeb", "v1", "extracts", "acme"))).not.toContain("capabilities.yaml");

      writeSupportMatrix(dir, "ax-arena/benchmark/daeb/v1/suite.yaml", SupportMatrixSchema.parse({
        schema: "ax.support-matrix/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [{
          vendor: "Acme",
          task_id: "db-T01-schema-migration",
          surface: "api",
          status: "supported",
          source_concept: "schema-migration",
        }],
      }));
      expect(loadSupportMatrix(dir, "ax-arena/benchmark/daeb/v1/suite.yaml")?.entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads legacy capabilities.yaml extracts and upgrades them to inventory shape", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-legacy-"));
    try {
      const extractDir = resolve(dir, "benchmarks", "daeb", "v1", "extracts", "acme");
      mkdirSync(extractDir, { recursive: true });
      writeFileSync(resolve(extractDir, "capabilities.yaml"), [
        "vendor: Acme",
        "slug: acme",
        "category: database",
        "extracted_at: 2026-01-01T00:00:00.000Z",
        "capabilities:",
        "  - name: row-level-security",
        "    title: Row-level security",
        "    description: Restrict row access by identity.",
        "    doc_url: https://docs.example/rls",
        "    doc_quote: Enable policies per row.",
        "",
      ].join("\n"));

      const loaded = loadCapabilityExtract(dir, "acme");
      expect(loaded?.capabilities).toHaveLength(1);
      expect(loaded?.capabilities[0]?.capability_name).toBe("row-level-security");
      expect(loaded?.capabilities[0]?.family).toBeUndefined();
      expect(loaded?.capabilities[0]?.evidence[0]?.doc_url).toBe("https://docs.example/rls");
      expect(readdirSync(resolve(dir, "ax-arena", "benchmark", "daeb", "v1", "extracts", "acme")))
        .toContain("capability-inventory.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed canonical capability inventory without a legacy fallback", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-malformed-"));
    try {
      const extractDir = resolve(dir, "ax-arena", "benchmark", "daeb", "v1", "extracts", "acme");
      mkdirSync(extractDir, { recursive: true });
      writeFileSync(resolve(extractDir, "capability-inventory.yaml"), "vendor: Acme\n");
      expect(() => loadCapabilityExtract(dir, "acme")).toThrow(/capability-extract.*malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a frozen implicit legacy read root while normalizing multiple vendors", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-legacy-batch-"));
    const warnings: string[] = [];
    try {
      for (const slug of ["acme", "bravo"]) {
        const extractDir = resolve(dir, "benchmarks", "daeb", "v1", "extracts", slug);
        mkdirSync(extractDir, { recursive: true });
        writeFileSync(resolve(extractDir, "capabilities.yaml"), [
          `vendor: ${slug}`,
          `slug: ${slug}`,
          "category: database",
          "extracted_at: 2026-01-01T00:00:00.000Z",
          "capabilities:",
          "  - name: row-read",
          "    title: Row read",
          "    description: Read one row.",
          "    doc_url: https://docs.example/read",
          "",
        ].join("\n"));
      }
      const paths = createDaebPathContext(dir, { warn: (message) => warnings.push(message) });
      expect(loadCapabilityExtract(paths, "acme")?.slug).toBe("acme");
      expect(loadCapabilityExtract(paths, "bravo")?.slug).toBe("bravo");
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("persists publication-grade methodology artifacts for both layers without coupling scores", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-pub-"));
    try {
      const suitePath = "ax-arena/benchmark/daeb/v1/suite.yaml";
      const methodology = defaultSuiteMethodology("database");
      writeMethodology(dir, suitePath, methodology);
      writeCoverageMatrix(dir, suitePath, {
        schema: "ax.coverage-matrix/v1",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        concepts: [{
          concept_name: "schema-migration",
          title: "Schema migration",
          decisions: [{
            concept_name: "schema-migration",
            vendor: "Acme",
            status: "supported",
            source: "inventory",
            capability_name: "schema-migration",
            family: "migration",
            evidence: [{ doc_url: "https://docs.example/migrate", quote: "Run tracked migrations." }],
          }],
        }],
      });
      writeSelectionLedger(dir, suitePath, {
        schema: "ax.selection-ledger/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        methodology,
        entries: [{
          concept_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          proposed_difficulty: "L3",
          coverage_pct: 1,
          covered_vendors: ["Acme"],
          task_fit_coverage_pct: 1,
          task_fit_vendors: ["Acme"],
          verifier_ready: true,
          tier: "core",
          verifiable: true,
          selected_by_model: true,
          selected: true,
          rationale: "High coverage and deterministic read-back.",
        }],
      });
      writeSupportMatrix(dir, suitePath, {
        schema: "ax.support-matrix/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "api", status: "supported", source_concept: "schema-migration" },
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "cli", status: "supported", source_concept: "schema-migration" },
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "sdk", status: "unsupported", source_concept: "schema-migration" },
        ],
      });
      writeGraderLedger(dir, suitePath, {
        schema: "ax.grader-ledger/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        tasks: [{
          task_id: "db-T01-schema-migration",
          outcome_graders: ["read-back-world-state"],
          trajectory_graders: ["transcript-review"],
          efficiency_metrics: ["turn_count"],
          human_calibration: ["grader-fairness-review"],
        }],
      });
      writeFailureTaxonomy(dir, suitePath, {
        schema: "ax.failure-taxonomy/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        categories: [{ id: "agent-failure", label: "Agent failure", description: "Agent could not complete a supported task." }],
      });
      writeTraceReview(dir, suitePath, {
        schema: "ax.trace-review/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
        sample_size: 10,
        sample_ids: [],
        findings: [],
        summary: "Review a fixed trace sample for every methodology revision.",
      });

      expect(methodologyPath(dir, suitePath)).toContain(".methodology.yaml");
      expect(coverageMatrixPath(dir, suitePath)).toContain(".coverage-matrix.yaml");
      expect(selectionLedgerPath(dir, suitePath)).toContain(".selection-ledger.yaml");
      expect(supportMatrixPath(dir, suitePath)).toContain(".support-matrix.yaml");
      expect(traceReviewPath(dir, suitePath)).toContain(".trace-review.yaml");
      expect(methodology.static_ax.notes[0]).toMatch(/never changes usability-suite pass rates/i);
      expect(methodology.behavioral.label).toBe("Usability Canonical Suite");
      expect(methodology.behavioral.notes[0]).toMatch(/usability-suite scoring/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
