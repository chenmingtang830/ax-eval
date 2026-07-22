import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { matchDeterministicDatabaseConcept } from "../src/authoring/coverage-gap-check.js";
import {
  CapabilityInventorySchema,
  writeCapabilityInventory,
  type CapabilityExtractResult,
  type CoverageMatrix,
} from "ax-eval";
import {
  findMappingFalsePositives,
  findStaleTaskFitFindings,
  findTaskFitAuditFindings,
} from "../src/authoring/suite-audit.js";

function cap(
  name: string,
  title = name,
  description = title,
): CapabilityExtractResult["capabilities"][number] {
  return {
    capability_name: name,
    title,
    description,
    resource_kind: "resource",
    operation_kind: "operate",
    surfaces_documented: ["api"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.example.test", quote: title }],
    extraction_provenance: {
      source: "official-docs",
      extracted_at: "2026-01-01T00:00:00.000Z",
      extractor: "test",
    },
  };
}

describe("deterministic concept mapping (suite-audit inputs)", () => {
  it("maps previously missed vendor-idiomatic capabilities onto canonical concepts", () => {
    expect(matchDeterministicDatabaseConcept(cap("row-level-access-control"))?.concept_name)
      .toBe("access-control");
    expect(matchDeterministicDatabaseConcept(cap("fine-grained-permissions"))?.concept_name)
      .toBe("access-control");
    expect(matchDeterministicDatabaseConcept(cap("realtime-subscriptions"))?.concept_name)
      .toBe("change-data-capture");
    expect(matchDeterministicDatabaseConcept(cap("change-data-capture"))?.concept_name)
      .toBe("change-data-capture");
    expect(matchDeterministicDatabaseConcept(cap("rest-data-api-crud"))?.concept_name)
      .toBe("write-records");
    expect(matchDeterministicDatabaseConcept(cap("baseline-sql-table-and-row-operations"))?.concept_name)
      .toBe("write-records");
    expect(matchDeterministicDatabaseConcept(cap("full-text-search-tsvector"))?.concept_name)
      .toBe("full-text-search");
  });

  it("rejects description-driven false positives and topology lookalikes", () => {
    expect(matchDeterministicDatabaseConcept(cap(
      "backup-blackout-windows",
      "Backup Blackout Windows",
      "Manage a dedicated CRUD API resource that suppresses scheduled backups.",
    ))).toBeNull();
    expect(matchDeterministicDatabaseConcept(cap(
      "cluster-disruption-testing",
      "Cluster disruption testing",
      "Create and update a disruption test through a CRUD API.",
    ))).toBeNull();
    expect(matchDeterministicDatabaseConcept(cap("read-replica"))).toBeNull();
  });

  it("keeps direct artifact and change-stream capabilities mapped", () => {
    expect(matchDeterministicDatabaseConcept(cap("bulk-export"))?.concept_name)
      .toBe("backup-and-restore");
    expect(matchDeterministicDatabaseConcept(cap("logical-replication-cdc"))?.concept_name)
      .toBe("change-data-capture");
    expect(matchDeterministicDatabaseConcept(cap("change-data-capture"))?.concept_name)
      .toBe("change-data-capture");
    expect(matchDeterministicDatabaseConcept(cap("transactional-writes"))?.concept_name)
      .toBe("data-integrity-and-transactions");
  });

  it("audits stale supported decisions that cite a false-positive capability", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-suite-false-positive-"));
    try {
      writeCapabilityInventory(root, CapabilityInventorySchema.parse({
        vendor: "Cockroachdb",
        slug: "cockroachdb",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [
          cap(
            "backup-blackout-windows",
            "Backup Blackout Windows",
            "Manage a CRUD API resource that suppresses scheduled backups.",
          ),
          cap("row-insert"),
        ],
      }));
      const coverage: CoverageMatrix = {
        schema: "ax.coverage-matrix/v1",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        concepts: [{
          concept_name: "write-records",
          title: "Write Records",
          decisions: [{
            concept_name: "write-records",
            vendor: "Cockroachdb",
            status: "supported",
            source: "inventory",
            capability_name: "backup-blackout-windows",
            surfaces_documented: ["api"],
            evidence: [],
          }],
        }],
      };

      const findings = findMappingFalsePositives(root, coverage, ["cockroachdb"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe("mapping_false_positive");
      expect(findings[0]?.message).toContain("row-insert");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects selected support decisions without concrete task-fit proof", () => {
    const coverage: CoverageMatrix = {
      schema: "ax.coverage-matrix/v1",
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [{
        concept_name: "change-data-capture",
        title: "Change Data Capture",
        decisions: [{
          concept_name: "change-data-capture",
          vendor: "Acme",
          status: "supported",
          source: "inventory",
          capability_name: "realtime-broadcast",
          surfaces_documented: ["api"],
          evidence: [],
        }],
      }],
    };
    const findings = findTaskFitAuditFindings(coverage, new Set(["change-data-capture"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("task_fit_unproven");
  });

  it("rejects support cells leaked from an insufficient task fit", () => {
    const coverage: CoverageMatrix = {
      schema: "ax.coverage-matrix/v1",
      category: "database",
      generated_at: "2026-01-01T00:00:00.000Z",
      concepts: [{
        concept_name: "write-records",
        title: "Write Records",
        decisions: [{
          concept_name: "write-records",
          vendor: "Acme",
          status: "supported",
          source: "inventory",
          capability_name: "row-insert",
          candidate_capabilities: [],
          capability_bundle: [],
          task_fit: {
            status: "insufficient",
            matched_requirements: ["create-record"],
            missing_requirements: ["update-record", "delete-record"],
            supported_surfaces: [],
            reason: "missing lifecycle operations",
          },
          surfaces_documented: [],
          evidence: [],
        }],
      }],
    };
    const findings = findTaskFitAuditFindings(
      coverage,
      new Set(["write-records"]),
      {
        schema: "ax.support-matrix/v1",
        benchmark: "DAEB-1",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [{
          vendor: "Acme",
          task_id: "db-T09-write-records",
          surface: "api",
          status: "supported",
          source_concept: "write-records",
        }],
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("task_fit_leaked_support");
  });

  it("recomputes stale task fit from the current inventory", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-stale-task-fit-"));
    try {
      writeCapabilityInventory(root, CapabilityInventorySchema.parse({
        vendor: "Nile",
        slug: "nile",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [{
          ...cap("automated-backup"),
          support_type: "managed-surface",
          surfaces_documented: ["api", "cli"],
        }],
      }));
      const coverage: CoverageMatrix = {
        schema: "ax.coverage-matrix/v1",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        concepts: [{
          concept_name: "backup-and-restore",
          title: "Backup",
          decisions: [{
            concept_name: "backup-and-restore",
            vendor: "Nile",
            status: "supported",
            source: "inventory",
            capability_name: "automated-backup",
            capability_bundle: ["automated-backup"],
            task_fit: {
              status: "sufficient",
              matched_requirements: ["artifact"],
              missing_requirements: [],
              supported_surfaces: ["api", "cli"],
            },
            surfaces_documented: ["api", "cli"],
            evidence: [],
          }],
        }],
      };
      const findings = findStaleTaskFitFindings(root, coverage, new Set(["backup-and-restore"]), ["nile"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe("task_fit_stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
