import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { matchDeterministicDatabaseConcept } from "../src/generate/coverage-gap-check.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import {
  CapabilityInventorySchema,
  writeCapabilityInventory,
  type CoverageMatrix,
} from "../src/generate/methodology.js";
import { findMappingFalsePositives } from "../src/generate/suite-audit.js";

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
});
