import { describe, expect, it } from "vitest";
import { matchDeterministicDatabaseConcept } from "../src/generate/coverage-gap-check.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";

function cap(name: string, title = name): CapabilityExtractResult["capabilities"][number] {
  return {
    capability_name: name,
    title,
    description: title,
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
});
