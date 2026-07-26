import { describe, expect, it } from "vitest";
import { evaluateDatabaseTaskFit } from "../src/authoring/database-task-fit.js";
import type { CapabilityExtractResult } from "ax-eval";

type Capability = CapabilityExtractResult["capabilities"][number];

function cap(
  capability_name: string,
  surfaces_documented: Array<"api" | "sdk" | "cli">,
  operation_kind = "operate",
  title = capability_name,
): Capability {
  return {
    capability_name,
    title,
    description: title,
    resource_kind: "resource",
    operation_kind,
    surfaces_documented,
    support_type: "native",
    evidence: [{ doc_url: "https://docs.example.test", quote: title, strength: "direct" }],
    extraction_provenance: {
      source: "official-docs",
      extracted_at: "2026-01-01T00:00:00.000Z",
      extractor: "test",
    },
  };
}

describe("database task-fit adjudication", () => {
  it("builds a same-surface create/update/delete bundle for record lifecycle", () => {
    const result = evaluateDatabaseTaskFit("write-records", [
      cap("row-insert", ["cli"], "create"),
      cap("row-update", ["cli"], "update"),
      cap("row-delete", ["cli"], "delete"),
    ]);
    expect(result?.status).toBe("sufficient");
    expect(result?.supported_surfaces).toEqual(["cli"]);
    expect(result?.capability_bundle).toEqual(["row-insert", "row-update", "row-delete"]);

    const compound = evaluateDatabaseTaskFit("write-records", [
      cap("row-insert-update-delete", ["api", "cli"], "create, update, delete"),
    ]);
    expect(compound?.status).toBe("sufficient");
    expect(compound?.capability_bundle).toEqual(["row-insert-update-delete"]);
  });

  it("ranks direct database-change evidence above client broadcast", () => {
    const result = evaluateDatabaseTaskFit("change-data-capture", [
      cap("realtime-broadcast", ["api"], "stream"),
      cap("change-data-capture", ["api", "sdk"], "stream"),
    ]);
    expect(result?.status).toBe("sufficient");
    expect(result?.capability_bundle).toEqual(["change-data-capture"]);
    expect(result?.candidates.map((candidate) => candidate.capability_name)).not.toContain("realtime-broadcast");
  });

  it("selects in-place migration and filtered data API evidence over lookalikes", () => {
    const schema = evaluateDatabaseTaskFit("evolve-schema", [
      cap("schema-diff-and-introspection", ["api", "cli"], "read"),
      cap("schema-migration-orm-tooling", ["cli"], "migrate"),
    ]);
    expect(schema?.capability_bundle).toEqual(["schema-migration-orm-tooling"]);
    expect(schema?.supported_surfaces).toEqual(["cli"]);

    const query = evaluateDatabaseTaskFit("query-records", [
      cap("time-travel-historical-query", ["cli"], "read"),
      cap("data-api-rest", ["api"], "read"),
    ]);
    expect(query?.capability_bundle).toEqual(["data-api-rest"]);
    expect(query?.supported_surfaces).toEqual(["api"]);
  });

  it("selects real vector search and row-level ACL instead of weak control-plane matches", () => {
    const vector = evaluateDatabaseTaskFit("vector-search", [
      cap("index-management", ["api"], "read"),
      cap("vector-search", ["api"], "search"),
    ]);
    expect(vector?.capability_bundle).toEqual(["vector-search"]);

    const acl = evaluateDatabaseTaskFit("access-control", [
      cap("custom-roles", ["api"], "create"),
      cap("row-level-access-control", ["api"], "read"),
    ]);
    expect(acl?.capability_bundle).toEqual(["row-level-access-control"]);
  });

  it("requires concrete duplicate rejection or an atomic check-and-write bundle", () => {
    const weak = evaluateDatabaseTaskFit("data-integrity-and-transactions", [
      cap("transactions", ["cli"], "transaction"),
    ]);
    expect(weak?.status).toBe("insufficient");

    const constraint = evaluateDatabaseTaskFit("data-integrity-and-transactions", [
      cap("unique-index-constraints", ["api"], "create"),
    ]);
    expect(constraint?.status).toBe("sufficient");
    expect(constraint?.requirement_path).toBe("constraint");

    const atomic = evaluateDatabaseTaskFit("data-integrity-and-transactions", [
      cap("transactional-writes", ["api"], "update"),
      cap("filtered-document-queries", ["api"], "read"),
    ]);
    expect(atomic?.status).toBe("sufficient");
    expect(atomic?.capability_bundle).toEqual(["transactional-writes", "filtered-document-queries"]);

    const recommendationOnly = evaluateDatabaseTaskFit("data-integrity-and-transactions", [{
      ...cap("primary-key-constraint", ["api"], "create"),
      evidence: [{
        doc_url: "https://docs.example/keys",
        quote: "It is recommended to create a primary key.",
        strength: "direct",
      }],
    }]);
    expect(recommendationOnly?.status).toBe("insufficient");
  });

  it("does not claim benchmark-surface schema evolution from SDK-only evidence", () => {
    const result = evaluateDatabaseTaskFit("evolve-schema", [
      cap("relational-schema-migration", ["api"], "migrate"),
      cap("schema-validation", ["sdk"], "validate"),
    ]);
    expect(result?.status).toBe("insufficient");
    expect(result?.supported_surfaces).toEqual([]);
  });

  it("removes GUI-only CLI attribution and deprecated full-text candidates", () => {
    const inspect = evaluateDatabaseTaskFit("inspect-schema", [{
      ...cap("schema-introspection", ["cli"], "read"),
      evidence: [{
        doc_url: "https://www.mongodb.com/docs/compass/schema/",
        quote: "The Schema tab in MongoDB Compass samples document fields.",
        strength: "direct",
      }],
    }]);
    expect(inspect?.status).toBe("insufficient");
    expect(inspect?.candidates[0]?.surfaces_documented).toEqual([]);
    expect(inspect?.candidates[0]?.surface_notes[0]).toContain("Compass GUI");

    const search = evaluateDatabaseTaskFit("full-text-search", [
      cap("full-text-search-bm25", ["cli"], "search", "BM25 Full-Text Search (deprecated)"),
      cap("full-text-search-tsvector", ["cli"], "search", "Full-Text Search via tsvector"),
    ]);
    expect(search?.capability_bundle).toEqual(["full-text-search-tsvector"]);
    expect(search?.candidates.map((candidate) => candidate.capability_name))
      .toEqual(["full-text-search-tsvector"]);
  });
});
