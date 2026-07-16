import { describe, expect, it } from "vitest";
import { recommendEvidenceStrength } from "../src/generate/evidence-strength.js";

describe("recommendEvidenceStrength", () => {
  it("recognizes direct HTTP, SQL, and SDK operation evidence", () => {
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/api/projects",
      quote: "POST /v1/projects/{project_id}/pause pauses a project.",
    })).toMatchObject({ recommended_strength: "direct", reason: "documented-http-operation" });
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/sql/tables",
      quote: "CREATE TABLE widgets (id bigint primary key);",
    })).toMatchObject({ recommended_strength: "direct", reason: "documented-sql-statement" });
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/sdk/collections",
      quote: "Use collection.insertOne({ name: 'widget' }) to create a document.",
    })).toMatchObject({ recommended_strength: "direct", reason: "documented-sdk-call" });
  });

  it("distinguishes connection-derived, summary-index, and marketing evidence", () => {
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/connect",
      quote: "Copy the project connection string for a PostgreSQL-compatible driver.",
    })).toMatchObject({ recommended_strength: "derived_from_connection_surface", reason: "connection-surface-derivation" });
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/llms.txt",
      quote: "Documentation index",
    })).toMatchObject({ recommended_strength: "summary_index", reason: "summary-index" });
    expect(recommendEvidenceStrength({
      doc_url: "https://example.com/products/database/features/branching",
      quote: "Create amazing developer experiences.",
    })).toMatchObject({ recommended_strength: "marketing_claim", reason: "marketing-page" });
  });

  it("does not mistake natural-language create claims for direct SQL", () => {
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/guides/projects",
      quote: "Create projects quickly from the dashboard.",
    })).toMatchObject({ recommended_strength: "inferred", reason: "insufficient-direct-evidence" });
  });

  it("reports declared-strength disagreement without mutating the declaration", () => {
    expect(recommendEvidenceStrength({
      doc_url: "https://docs.example.com/api/projects",
      quote: "DELETE /v1/projects/{id}",
      declared_strength: "derived_from_connection_surface",
    })).toEqual({
      declared_strength: "derived_from_connection_surface",
      recommended_strength: "direct",
      disagrees_with_declared: true,
      reason: "documented-http-operation",
    });
  });

  it("treats malformed URLs as insufficient rather than throwing", () => {
    expect(recommendEvidenceStrength({
      doc_url: "not a url",
      quote: "A capability may be available.",
    })).toMatchObject({ recommended_strength: "inferred", disagrees_with_declared: false });
  });

  it("rejects invalid runtime declarations from untyped artifacts", () => {
    expect(() => recommendEvidenceStrength({
      doc_url: "https://docs.example.com",
      quote: "Evidence",
      declared_strength: "strong" as "direct",
    })).toThrow(/declared_strength is invalid/);
  });
});
