import { describe, expect, it } from "vitest";
import { buildCapabilityPrompt } from "../src/generate/capability-extract.js";

describe("capability extraction prompt", () => {
  it("requires baseline database ops in the inventory contract", () => {
    const prompt = buildCapabilityPrompt({
      vendor: "AcmeDB",
      slug: "acmedb",
      category: "database",
      docs_url: "https://docs.example.com",
      site_url: "https://example.com",
    });

    expect(prompt).toMatch(/baseline operational capabilities/i);
    expect(prompt).toMatch(/create table\/collection/i);
    expect(prompt).toMatch(/insert rows\/documents/i);
    expect(prompt).toMatch(/filtered reads\/querying/i);
    expect(prompt).toMatch(/schema introspection/i);
    expect(prompt).toMatch(/tracked schema changes/i);
    expect(prompt).toMatch(/Coverage checklist to close before you stop:/);
  });
});
