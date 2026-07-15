import { describe, expect, it } from "vitest";
import { buildCapabilityPrompt, extractCapabilities } from "../src/generate/capability-extract.js";
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
});
