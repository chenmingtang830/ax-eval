import { describe, expect, it } from "vitest";
import {
  buildCoverageMatrixArtifact,
  buildSelectionLedgerArtifact,
  buildSupportMatrixArtifact,
  calibrateDifficultyFromTrials,
  draftTask,
  inferDifficultyFromConcept,
  inferSuiteVersionFromStem,
  proposeClustersFromUniverse,
  resolveConceptDifficulty,
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

  it("calibrates difficulty from trial pass rate and tool-call volume", () => {
    expect(inferDifficultyFromConcept("backup-and-restore")).toBe("L4");
    expect(calibrateDifficultyFromTrials({ meanPassRate: 0.95, meanToolCalls: 3 })).toBe("L1");
    expect(calibrateDifficultyFromTrials({ meanPassRate: 0.7, meanToolCalls: 10 })).toBe("L2");
    expect(calibrateDifficultyFromTrials({ meanPassRate: 0.7, meanToolCalls: 25 })).toBe("L3");
    expect(calibrateDifficultyFromTrials({ meanPassRate: 0.2 })).toBe("L4");
    expect(resolveConceptDifficulty("access-control")).toBe("L2");
    expect(resolveConceptDifficulty("access-control", { meanPassRate: 0.9, meanToolCalls: 2 })).toBe("L1");
  });

  it("derives supported surfaces from capability inventories instead of assuming all surfaces", () => {
    const methodology = {
      ...defaultSuiteMethodology("database"),
      // Include sdk so the matrix still adjudicates research surfaces beyond DAEB v1 scope.
      surface_scope: ["api", "sdk", "cli"] as Array<"api" | "sdk" | "cli">,
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

  it("retains ranked alternatives and selects a same-surface lifecycle bundle", () => {
    const capabilities = ([
      ["row-insert", "create"],
      ["row-update", "update"],
      ["row-delete", "delete"],
    ] as const).map(([capability_name, operation_kind]) => ({
      capability_name,
      title: capability_name,
      family: "data-write",
      description: capability_name,
      resource_kind: "row",
      operation_kind,
      surfaces_documented: ["cli"] as Array<"api" | "sdk" | "cli">,
      support_type: "native" as const,
      evidence: [{ doc_url: `https://docs.example/${capability_name}`, quote: capability_name, strength: "direct" as const }],
      extraction_provenance: { source: "official-docs" as const, extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
    }));
    const extracts: CapabilityExtractResult[] = [{
      vendor: "Cockroachdb",
      slug: "cockroachdb",
      category: "database",
      extracted_at: "2026-01-01T00:00:00.000Z",
      capabilities,
    }];
    const universe: ConceptUniverse = {
      schema: "ax.concept-universe/v1",
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      clusters: [{
        concept_name: "write-records",
        title: "Write Records",
        coverage: capabilities.map((capability) => ({
          vendor: "Cockroachdb",
          capability_name: capability.capability_name,
        })),
      }],
    };

    const matrix = buildCoverageMatrixArtifact("database", universe, extracts, []);
    const decision = matrix.concepts[0]?.decisions[0];
    expect(decision?.candidate_capabilities?.map((candidate) => candidate.capability_name).sort())
      .toEqual(["row-delete", "row-insert", "row-update"]);
    expect(decision?.capability_bundle).toEqual(["row-insert", "row-update", "row-delete"]);
    expect(decision?.task_fit?.status).toBe("sufficient");
    expect(decision?.task_fit?.supported_surfaces).toEqual(["cli"]);
    expect(decision?.candidate_capabilities?.every((candidate) => candidate.evidence.length > 0)).toBe(true);
  });

  it("preserves documented Convex CLI support instead of applying a vendor-wide denial", () => {
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
        concept_name: "backup-and-restore",
        title: "Backup And Restore",
        decisions: [{
          concept_name: "backup-and-restore",
          vendor: "Convex",
          status: "supported" as const,
          source: "inventory" as const,
          capability_name: "bulk-export",
          surfaces_documented: ["cli"] as Array<"api" | "sdk" | "cli">,
          evidence: [{ doc_url: "https://docs.convex.dev/database/import-export/export", quote: "npx convex export" }],
        }],
      }],
    };
    const task: SynthesizedTask = {
      id: "db-T02-backup-and-restore",
      title: "T02: Produce an export artifact",
      difficulty: "L4",
      skill: "backup-and-restore",
      intent: "Produce an export.",
      oracle_hint: "Read it back.",
      allowed_surfaces: ["api", "cli"],
      na_examples: [],
      rationale: "Selected.",
      coverage: [{ vendor: "Convex", capability_name: "bulk-export" }],
    };
    const support = buildSupportMatrixArtifact(
      "DAEB-1",
      "database",
      methodology,
      coverageMatrix,
      [task],
      [{
        cluster_name: "backup-and-restore",
        title: "Backup And Restore",
        difficulty: "L4",
        rationale: "Selected.",
        coverage: task.coverage,
      }],
    );

    expect(support.entries.find((entry) => entry.surface === "cli")?.status).toBe("supported");
    expect(support.entries.find((entry) => entry.surface === "api")?.status).toBe("unsupported");
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
      surface_scope: ["api", "sdk", "cli"] as Array<"api" | "sdk" | "cli">,
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
      surface_scope: ["api", "sdk", "cli"] as Array<"api" | "sdk" | "cli">,
      target_task_count: 4,
      min_vendor_coverage_pct: 0.5,
    };
    const coverageMatrix = {
      schema: "ax.coverage-matrix/v1" as const,
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [
        {
          concept_name: "evolve-schema",
          title: "Evolve Schema",
          decisions: ["Supabase", "Neon", "MongoDB Atlas"].map((vendor) => ({
            concept_name: "evolve-schema",
            vendor,
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: "schema-migration",
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
        id: "db-T04-evolve-schema",
        title: "T04: Apply a schema evolution",
        difficulty: "L3",
        skill: "evolve-schema",
        intent: "Evolve a container.",
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
      { cluster_name: "evolve-schema", title: "Evolve Schema", difficulty: "L3", rationale: "Selected.", coverage: [] },
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

    expect(status("Supabase", "db-T04-evolve-schema", "api")?.status).toBe("supported");
    expect(status("Supabase", "db-T04-evolve-schema", "sdk")?.status).toBe("unsupported");
    expect(status("Supabase", "db-T04-evolve-schema", "sdk")?.reason).toContain("does not expose the DDL/control-plane path");
    expect(status("Neon", "db-T04-evolve-schema", "sdk")?.status).toBe("supported");
    expect(status("Neon", "db-T02-backup-and-restore", "sdk")?.status).toBe("unsupported");
    expect(status("MongoDB Atlas", "db-T04-evolve-schema", "sdk")?.status).toBe("supported");
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
    }], { targetTaskCount: 1, deterministic: true });

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
