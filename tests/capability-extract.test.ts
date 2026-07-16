import { describe, expect, it } from "vitest";
import { buildCapabilityPrompt, extractCapabilities } from "../src/generate/capability-extract.js";
import { summarizeOpenApiText } from "../src/ingest/spec-summary.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

const vendor: ResolveResult = {
  vendor: "AcmeDB",
  slug: "acmedb",
  category: "database",
  discovered_at: "2026-01-01T00:00:00.000Z",
  resolver: { method: "grounded-generator", prompt_version: "test" },
  site_url: "https://acme.example",
  docs_url: "https://docs.acme.example",
};

describe("capability extraction", () => {
  it("requires baseline database operations and official evidence", () => {
    const prompt = buildCapabilityPrompt(vendor);
    expect(prompt).toMatch(/create table\/collection/i);
    expect(prompt).toMatch(/filtered reads\/querying/i);
    expect(prompt).toMatch(/official vendor documentation/i);
  });

  it("accepts official cited evidence and rejects unrelated hosts", async () => {
    const capability = {
      capability_name: "schema-ddl",
      title: "Schema definition",
      family: "data-definition",
      description: "Create and inspect tables.",
      resource_kind: "table",
      operation_kind: "create",
      surfaces_documented: ["api"],
      support_type: "native",
      evidence: [{ doc_url: "https://docs.acme.example/schema", quote: "Create a table." }],
    };
    const result = await extractCapabilities(vendor, {
      generate: async () => JSON.stringify({ capabilities: [capability] }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.capabilities[0]?.capability_name).toBe("schema-ddl");
    await expect(extractCapabilities(vendor, {
      generate: async () => JSON.stringify({
        capabilities: [{ ...capability, evidence: [{ doc_url: "https://unrelated.example/docs", quote: "Claim." }] }],
      }),
    })).rejects.toThrow(/non-official host/);
  });

  it("normalizes a bare capability array without weakening item validation", async () => {
    const capability = {
      capability_name: "schema-ddl",
      title: "Schema definition",
      family: "data-definition",
      description: "Create and inspect tables.",
      resource_kind: "table",
      operation_kind: "create",
      surfaces_documented: ["api"],
      support_type: "native",
      evidence: [{ doc_url: "https://docs.acme.example/schema", quote: "Create a table." }],
    };
    const result = await extractCapabilities(vendor, {
      generate: async () => JSON.stringify([capability]),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.capabilities).toHaveLength(1);

    await expect(extractCapabilities(vendor, {
      generate: async () => JSON.stringify([{ ...capability, evidence: [] }]),
    })).rejects.toThrow(/invalid/);
  });

  it("seeds from reviewed OpenAPI operations and records their provenance", async () => {
    const summary = summarizeOpenApiText(JSON.stringify({
      info: { title: "Acme API" },
      paths: { "/tables": { post: { summary: "Create a table", tags: ["tables"] } } },
    }), "https://docs.acme.example/openapi.json");
    let prompt = "";
    const result = await extractCapabilities(vendor, {
      specSummary: summary,
      generate: async (value) => {
        prompt = value;
        return JSON.stringify({ capabilities: [{
          capability_name: "schema-ddl",
          title: "Schema definition",
          family: "data-definition",
          description: "Create tables.",
          resource_kind: "table",
          operation_kind: "create",
          surfaces_documented: ["api"],
          support_type: "native",
          evidence: [{ doc_url: "https://docs.acme.example/openapi.json", quote: "method=POST path=\"/tables\"" }],
        }] });
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(prompt).toContain("REVIEWED OPENAPI OPERATIONS");
    expect(prompt).toContain('method=POST path="/tables"');
    expect(result.extraction_provenance.spec_seed).toEqual({
      source: "https://docs.acme.example/openapi.json",
      operation_count: 1,
      truncated: false,
    });
  });

  it("rejects a remote spec seed outside the vendor's official hosts", async () => {
    const summary = summarizeOpenApiText(JSON.stringify({
      paths: { "/tables": { get: { summary: "List tables" } } },
    }), "https://third-party.example/openapi.json");
    await expect(extractCapabilities(vendor, {
      specSummary: summary,
      generate: async () => "should not run",
    })).rejects.toThrow(/non-official host/);
  });

  it("fails closed when a spec seed is empty or truncated", async () => {
    const empty = summarizeOpenApiText(JSON.stringify({ paths: {} }), "https://docs.acme.example/openapi.json");
    await expect(extractCapabilities(vendor, {
      specSummary: empty,
      generate: async () => "should not run",
    })).rejects.toThrow(/no operations/);

    const truncated = summarizeOpenApiText(JSON.stringify({
      paths: {
        "/tables": { get: { summary: "List tables" } },
        "/rows": { get: { summary: "List rows" } },
      },
    }), "https://docs.acme.example/openapi.json", 1);
    await expect(extractCapabilities(vendor, {
      specSummary: truncated,
      generate: async () => "should not run",
    })).rejects.toThrow(/truncated/);
  });
});
