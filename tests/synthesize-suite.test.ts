import { describe, expect, it } from "vitest";
import {
  buildCoverageMatrixArtifact,
  buildSelectionLedgerArtifact,
  buildSupportMatrixArtifact,
  draftTask,
  inferSuiteVersionFromStem,
  proposeClustersFromUniverse,
  synthesizeSuite,
  type SynthesizedTask,
} from "../src/generate/synthesize-suite.js";
import { defaultSuiteMethodology, type ConceptUniverse } from "../src/generate/methodology.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";

describe("synthesize-suite helpers", () => {
  it("infers suite version from the output stem", () => {
    expect(inferSuiteVersionFromStem("daeb-1")).toBe(1);
    expect(inferSuiteVersionFromStem("daeb-1-v3")).toBe(3);
    expect(inferSuiteVersionFromStem("demo-suite-v12")).toBe(12);
  });

  it("derives supported surfaces from capability inventories instead of assuming all surfaces", () => {
    const methodology = {
      ...defaultSuiteMethodology("database"),
      target_task_count: 1,
      min_vendor_coverage_pct: 0.5,
    };
    const extracts: CapabilityExtractResult[] = [
      {
        vendor: "Acme",
        slug: "acme",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [{
          capability_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          description: "Tracked schema changes",
          resource_kind: "table",
          operation_kind: "migrate",
          surfaces_documented: ["api", "cli"],
          support_type: "native",
          evidence: [{ doc_url: "https://docs.example/migrate", quote: "Use the API or CLI." }],
          extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
        }],
      },
      {
        vendor: "Bravo",
        slug: "bravo",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [{
          capability_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          description: "Tracked schema changes",
          resource_kind: "table",
          operation_kind: "migrate",
          surfaces_documented: ["sdk"],
          support_type: "native",
          evidence: [{ doc_url: "https://docs.example/sdk-migrate", quote: "Use the SDK." }],
          extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
        }],
      },
    ];
    const conceptUniverse: ConceptUniverse = {
      schema: "ax.concept-universe/v1",
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      clusters: [{
        concept_name: "schema-migration",
        title: "Schema migration",
        coverage: [
          { vendor: "Acme", capability_name: "schema-migration" },
          { vendor: "Bravo", capability_name: "schema-migration" },
        ],
      }],
    };
    const coverageMatrix = buildCoverageMatrixArtifact("database", conceptUniverse, extracts, []);
    const proposed = proposeClustersFromUniverse(conceptUniverse, coverageMatrix);
    const selectionLedger = buildSelectionLedgerArtifact(
      "DATABASE-CANONICAL",
      "database",
      methodology,
      conceptUniverse,
      coverageMatrix,
      proposed,
    );
    const selectedClusters = selectionLedger.entries
      .filter((entry) => entry.selected)
      .map((entry) => ({
        cluster_name: entry.concept_name,
        title: entry.title,
        difficulty: entry.proposed_difficulty ?? "L3",
        rationale: entry.rationale,
        coverage: conceptUniverse.clusters.find((cluster) => cluster.concept_name === entry.concept_name)?.coverage ?? [],
      }));
    const tasks: SynthesizedTask[] = [{
      id: "db-T01-schema-migration",
      title: "T01: schema migration",
      difficulty: "L3",
      skill: "schema-migration",
      intent: "Apply a tracked schema migration.",
      oracle_hint: "Read it back.",
      allowed_surfaces: ["api", "sdk", "cli"],
      na_examples: [],
      rationale: "Selected for coverage.",
      coverage: selectedClusters[0]?.coverage ?? [],
    }];

    const supportMatrix = buildSupportMatrixArtifact(
      "DATABASE-CANONICAL",
      "database",
      methodology,
      coverageMatrix,
      tasks,
      selectedClusters,
    );

    expect(coverageMatrix.concepts[0]?.decisions.find((decision) => decision.vendor === "Acme")?.surfaces_documented).toEqual(["api", "cli"]);
    expect(coverageMatrix.concepts[0]?.decisions.find((decision) => decision.vendor === "Bravo")?.surfaces_documented).toEqual(["sdk"]);

    const byVendorSurface = new Map(
      supportMatrix.entries.map((entry) => [`${entry.vendor}:${entry.surface}`, entry.status] as const),
    );
    expect(byVendorSurface.get("Acme:api")).toBe("supported");
    expect(byVendorSurface.get("Acme:cli")).toBe("supported");
    expect(byVendorSurface.get("Acme:sdk")).toBe("unsupported");
    expect(byVendorSurface.get("Bravo:sdk")).toBe("supported");
    expect(byVendorSurface.get("Bravo:api")).toBe("unsupported");
    expect(byVendorSurface.get("Bravo:cli")).toBe("unsupported");
  });

  it("uses deterministic database task templates for selected concepts", async () => {
    const task = await draftTask(
      "database",
      {
        cluster_name: "define-data-container",
        title: "Define Data Container",
        difficulty: "L1",
        rationale: "Selected for coverage.",
        coverage: [{ vendor: "Acme", capability_name: "create-table" }],
      },
      [],
      0,
    );

    expect(task.id).toBe("db-T01-define-data-container");
    expect(task.skill).toBe("define-data-container");
    expect(task.intent).toContain("axarena_items_{ns}");
    expect(task.oracle_hint).toContain("Read back metadata");
  });

  it("keeps MongoDB Atlas $function out of the named routine task support decision", () => {
    const methodology = {
      ...defaultSuiteMethodology("database"),
      target_task_count: 1,
      min_vendor_coverage_pct: 0.5,
    };
    const coverageMatrix = {
      schema: "ax.coverage-matrix/v1" as const,
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [{
        concept_name: "server-side-execution",
        title: "Server-Side Execution",
        decisions: [{
          concept_name: "server-side-execution",
          vendor: "MongoDB Atlas",
          status: "supported" as const,
          source: "inventory" as const,
          capability_name: "server-side-javascript-function",
          family: "server-side-execution",
          surfaces_documented: ["api", "sdk", "cli"],
          evidence: [{
            doc_url: "https://www.mongodb.com/docs/manual/reference/operator/aggregation/function/",
            quote: "Defines a custom aggregation function or expression in JavaScript.",
          }],
        }, {
          concept_name: "server-side-execution",
          vendor: "AcmeDB",
          status: "supported" as const,
          source: "inventory" as const,
          capability_name: "stored-procedure",
          family: "server-side-execution",
          surfaces_documented: ["api", "sdk", "cli"],
          evidence: [{
            doc_url: "https://docs.example/functions",
            quote: "Create and invoke named stored procedures.",
          }],
        }],
      }],
    };
    const task: SynthesizedTask = {
      id: "db-T08-server-side-execution",
      title: "T08: Create and invoke a server-side routine",
      difficulty: "L3",
      skill: "server-side-execution",
      intent: "Create a server-side routine named `axarena_echo_{ns}`.",
      oracle_hint: "Read back the routine metadata and observable output.",
      allowed_surfaces: ["api", "sdk", "cli"],
      na_examples: [],
      rationale: "Selected for coverage.",
      coverage: [
        { vendor: "MongoDB Atlas", capability_name: "server-side-javascript-function" },
        { vendor: "AcmeDB", capability_name: "stored-procedure" },
      ],
    };

    const supportMatrix = buildSupportMatrixArtifact(
      "DATABASE-CANONICAL",
      "database",
      methodology,
      coverageMatrix,
      [task],
      [{
        cluster_name: "server-side-execution",
        title: "Server-Side Execution",
        difficulty: "L3",
        rationale: "Selected for coverage.",
        coverage: task.coverage,
      }],
    );

    const mongodbEntries = supportMatrix.entries.filter((entry) => entry.vendor === "MongoDB Atlas");
    expect(mongodbEntries.map((entry) => entry.status)).toEqual(["unsupported", "unsupported", "unsupported"]);
    expect(mongodbEntries[0]?.reason).toContain("inline aggregation `$function`");
    expect(supportMatrix.entries.filter((entry) => entry.vendor === "AcmeDB").map((entry) => entry.status)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });

  it("adjudicates database SDK support per task instead of inheriting API support", () => {
    const methodology = {
      ...defaultSuiteMethodology("database"),
      target_task_count: 4,
      min_vendor_coverage_pct: 0.5,
    };
    const coverageMatrix = {
      schema: "ax.coverage-matrix/v1" as const,
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [
        {
          concept_name: "define-data-container",
          title: "Define Data Container",
          decisions: ["Supabase", "Neon", "MongoDB Atlas"].map((vendor) => ({
            concept_name: "define-data-container",
            vendor,
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: "create-container",
            family: "data-definition",
            surfaces_documented: ["api", "sdk", "cli"] as Array<"api" | "sdk" | "cli">,
            evidence: [{ doc_url: "https://docs.example", quote: "Supported." }],
          })),
        },
        {
          concept_name: "backup-and-restore",
          title: "Backup And Restore",
          decisions: ["Supabase", "Neon", "MongoDB Atlas"].map((vendor) => ({
            concept_name: "backup-and-restore",
            vendor,
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: "backup",
            family: "recovery",
            surfaces_documented: ["api", "sdk", "cli"] as Array<"api" | "sdk" | "cli">,
            evidence: [{ doc_url: "https://docs.example/backup", quote: "Supported." }],
          })),
        },
      ],
    };
    const tasks: SynthesizedTask[] = [
      {
        id: "db-T04-define-data-container",
        title: "T04: Create a logical data container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create a container.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
        rationale: "Selected.",
        coverage: [],
      },
      {
        id: "db-T02-backup-and-restore",
        title: "T02: Produce a recoverable backup artifact",
        difficulty: "L4",
        skill: "backup-and-restore",
        intent: "Create a backup.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
        rationale: "Selected.",
        coverage: [],
      },
    ];
    const selectedClusters = [
      { cluster_name: "define-data-container", title: "Define Data Container", difficulty: "L1", rationale: "Selected.", coverage: [] },
      { cluster_name: "backup-and-restore", title: "Backup And Restore", difficulty: "L4", rationale: "Selected.", coverage: [] },
    ];

    const supportMatrix = buildSupportMatrixArtifact(
      "DATABASE-CANONICAL",
      "database",
      methodology,
      coverageMatrix,
      tasks,
      selectedClusters,
    );
    const status = (vendor: string, taskId: string, surface: "api" | "sdk" | "cli") =>
      supportMatrix.entries.find((entry) => entry.vendor === vendor && entry.task_id === taskId && entry.surface === surface);

    expect(status("Supabase", "db-T04-define-data-container", "api")?.status).toBe("supported");
    expect(status("Supabase", "db-T04-define-data-container", "sdk")?.status).toBe("unsupported");
    expect(status("Supabase", "db-T04-define-data-container", "sdk")?.reason).toContain("does not expose the DDL/control-plane path");
    expect(status("Neon", "db-T04-define-data-container", "sdk")?.status).toBe("supported");
    expect(status("Neon", "db-T02-backup-and-restore", "sdk")?.status).toBe("unsupported");
    expect(status("MongoDB Atlas", "db-T04-define-data-container", "sdk")?.status).toBe("supported");
    expect(status("MongoDB Atlas", "db-T02-backup-and-restore", "sdk")?.status).toBe("unsupported");
  });

  it("persists the execution-learning failure taxonomy used for DAEB-1 hardening", async () => {
    const result = await synthesizeSuite("database", [{
      vendor: "Acme",
      slug: "acme",
      category: "database",
      extracted_at: "2026-01-01T00:00:00.000Z",
      capabilities: [{
        capability_name: "create-table",
        title: "Create table",
        family: "data-definition",
        description: "Create a table.",
        resource_kind: "table",
        operation_kind: "create",
        surfaces_documented: ["api", "sdk", "cli"],
        support_type: "native",
        evidence: [{ doc_url: "https://docs.example/tables", quote: "Create tables." }],
        extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
      }],
    }], { targetTaskCount: 1 });

    expect(result.failureTaxonomy.categories.map((category) => category.id)).toEqual([
      "generic-harness-tooling-bug",
      "generic-methodology-artifact-bug",
      "database-category-seed-template-verifier-bug",
      "vendor-specific-adapter-bug",
      "agent-execution-failure",
    ]);
  });

  it("caps selected ledger entries at target_task_count", () => {
    const methodology = {
      ...defaultSuiteMethodology("database"),
      target_task_count: 1,
      family_diversity_cap: 5,
      min_vendor_coverage_pct: 0.5,
    };
    const conceptUniverse: ConceptUniverse = {
      schema: "ax.concept-universe/v1",
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      clusters: [
        {
          concept_name: "define-data-container",
          title: "Define Data Container",
          coverage: [{ vendor: "Acme", capability_name: "create-table" }],
        },
        {
          concept_name: "write-records",
          title: "Write Records",
          coverage: [{ vendor: "Acme", capability_name: "row-insert" }],
        },
      ],
    };
    const coverageMatrix = {
      schema: "ax.coverage-matrix/v1" as const,
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [
        {
          concept_name: "define-data-container",
          title: "Define Data Container",
          decisions: [{
            concept_name: "define-data-container",
            vendor: "Acme",
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: "create-table",
            family: "data-definition",
            evidence: [],
          }],
        },
        {
          concept_name: "write-records",
          title: "Write Records",
          decisions: [{
            concept_name: "write-records",
            vendor: "Acme",
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: "row-insert",
            family: "data-write",
            evidence: [],
          }],
        },
      ],
    };
    const proposed = proposeClustersFromUniverse(conceptUniverse, coverageMatrix);

    const ledger = buildSelectionLedgerArtifact(
      "DATABASE-CANONICAL",
      "database",
      methodology,
      conceptUniverse,
      coverageMatrix,
      proposed,
    );

    expect(ledger.entries.filter((entry) => entry.selected)).toHaveLength(1);
  });
});
