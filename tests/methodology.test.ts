import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CapabilityInventorySchema,
  SupportMatrixSchema,
  TraceReviewMemoSchema,
  auditCapabilityInventory,
  coverageMatrixPath,
  defaultSuiteMethodology,
  loadSupportMatrix,
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
} from "../src/generate/methodology.js";
import { loadCapabilityExtract } from "../src/generate/capability-extract.js";
import { auditSurfaceExtract } from "../src/generate/surface-extract.js";

describe("suite methodology artifacts", () => {
  it("defaults database suite scope to api/cli (DAEB v1); other categories keep api/sdk/cli", () => {
    const database = defaultSuiteMethodology("database");
    expect(database.surface_scope).toEqual(["api", "cli"]);
    expect(database.static_ax.dimensions).toContain("discoverability");
    expect(database.behavioral.source_of_truth).toMatch(/world state/i);

    const generic = defaultSuiteMethodology("crm");
    expect(generic.surface_scope).toEqual(["api", "sdk", "cli"]);
  });

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

  it("audits weak capability evidence before inventory publication", () => {
    const audited = auditCapabilityInventory(CapabilityInventorySchema.parse({
      vendor: "MongoDB Atlas",
      slug: "mongodb-atlas",
      category: "database",
      extracted_at: "2026-01-01T02:00:00.000Z",
      capabilities: [{
        capability_name: "document-insert",
        title: "Document insert",
        description: "Insert documents via the MongoDB driver.",
        resource_kind: "document",
        operation_kind: "create",
        surfaces_documented: ["api", "sdk"],
        support_type: "native",
        evidence: [{
          doc_url: "https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/",
          quote: "POST /api/atlas/v2/groups/{groupId}/clusters - Create One Cluster",
          note: "Cluster provisioning exposes a standard MongoDB connection string; insertOne is available via any MongoDB driver.",
        }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T00:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }, {
        capability_name: "view-creation",
        title: "View creation",
        description: "Create a view.",
        resource_kind: "view",
        operation_kind: "create",
        surfaces_documented: ["sdk", "cli"],
        support_type: "native",
        evidence: [{ doc_url: "https://docs.example/llms.txt", quote: "CREATE VIEW - Named queries" }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T02:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }],
    }));

    expect(audited.capabilities[0]?.surfaces_documented).toEqual(["sdk"]);
    expect(audited.capabilities[0]?.support_type).toBe("idiomatic-pattern");
    expect(audited.capabilities[0]?.evidence[0]?.strength).toBe("derived_from_connection_surface");
    expect(audited.capabilities[0]?.extraction_provenance.extracted_at).toBe("2026-01-01T02:00:00.000Z");
    expect(audited.capabilities[1]?.evidence[0]?.strength).toBe("summary_index");
    expect(audited.audit_notes.join("\n")).toMatch(/connection-derived data-plane/);
    expect(audited.audit_notes.join("\n")).toMatch(/summary-index evidence/);
  });

  it("audits suspicious surface auth before publication", () => {
    const audited = auditSurfaceExtract({
      vendor: "Neon",
      slug: "neon",
      extracted_at: "2026-01-01T00:00:00.000Z",
      cli: {
        bin: "neon",
        docs_url: "https://neon.com/docs/cli",
        auth: {
          kind: "inherit",
          token_env_aliases: [],
          instructions: "Point your MCP client at the server URL and approve access in the browser.",
        },
      },
      sdk: null,
      mcp: null,
    });

    expect(audited.schema).toBe("ax.surface-extract/v1");
    expect(audited.audit_notes.join("\n")).toMatch(/copied from another surface/);
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

  it("requires explicit reviewer metadata and a full sample before trace review completion", () => {
    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1"],
      findings: [],
      summary: "Reviewed.",
    }).success).toBe(false);

    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1", "trace-2"],
      reviewer: "Reviewer",
      reviewed_at: "2026-01-01T01:00:00.000Z",
      commit_sha: "abcdef123456",
      findings: ["No blocker."],
      summary: "Reviewed.",
    }).success).toBe(true);
  });
});
