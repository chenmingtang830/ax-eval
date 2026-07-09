import { describe, expect, it } from "vitest";
import { deriveCandidateUniverseDeterministic } from "../src/generate/coverage-gap-check.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";

function extract(vendor: string, capabilities: CapabilityExtractResult["capabilities"]): CapabilityExtractResult {
  return {
    vendor,
    slug: vendor.toLowerCase(),
    category: "database",
    extracted_at: "2026-01-01T00:00:00.000Z",
    capabilities,
  };
}

function capability(
  capability_name: string,
  family: string,
  title = capability_name,
): CapabilityExtractResult["capabilities"][number] {
  return {
    capability_name,
    title,
    family,
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

describe("deriveCandidateUniverseDeterministic", () => {
  it("clusters normalized database capabilities into shared canonical concepts", () => {
    const clusters = deriveCandidateUniverseDeterministic([
      extract("Supabase", [
        capability("create-table", "data-definition"),
        capability("row-insert", "data-write"),
        capability("schema-introspection", "data-read"),
      ]),
      extract("MongoDB Atlas", [
        capability("create-collection", "data-definition"),
        capability("document-insert", "data-write"),
        capability("collection-introspection", "data-read"),
      ]),
      extract("Convex", [
        capability("document-data-model", "data-definition"),
        capability("document-patch-update", "data-write"),
        capability("system-table-introspection", "data-read"),
      ]),
    ]);

    const byConcept = new Map(clusters.map((cluster) => [cluster.concept_name, cluster]));
    expect(byConcept.get("define-data-container")?.vendors_citing).toEqual([
      { vendor: "Supabase", capability_name: "create-table" },
      { vendor: "MongoDB Atlas", capability_name: "create-collection" },
      { vendor: "Convex", capability_name: "document-data-model" },
    ]);
    expect(byConcept.get("write-records")?.vendors_citing).toEqual([
      { vendor: "Supabase", capability_name: "row-insert" },
      { vendor: "MongoDB Atlas", capability_name: "document-insert" },
      { vendor: "Convex", capability_name: "document-patch-update" },
    ]);
    expect(byConcept.get("inspect-schema")?.vendors_citing).toEqual([
      { vendor: "Supabase", capability_name: "schema-introspection" },
      { vendor: "MongoDB Atlas", capability_name: "collection-introspection" },
      { vendor: "Convex", capability_name: "system-table-introspection" },
    ]);
  });

  it("preserves unmatched capabilities as singleton concepts instead of dropping them", () => {
    const clusters = deriveCandidateUniverseDeterministic([
      extract("Acme", [
        capability("postgresql-wire-compatibility", "core-operations", "PostgreSQL wire compatibility"),
      ]),
    ]);

    expect(clusters).toEqual([
      {
        concept_name: "postgresql-wire-compatibility",
        title: "PostgreSQL wire compatibility",
        vendors_citing: [{ vendor: "Acme", capability_name: "postgresql-wire-compatibility" }],
      },
    ]);
  });
});
