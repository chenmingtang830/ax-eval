import { describe, expect, it } from "vitest";
import { buildCapabilityPrompt, normalizeSurfacesDocumented } from "../src/generate/capability-extract.js";

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

  it("seeds from OpenAPI ops but still requires WebFetch gap-fill", () => {
    const prompt = buildCapabilityPrompt(
      {
        vendor: "AcmeDB",
        slug: "acmedb",
        category: "database",
        docs_url: "https://docs.example.com",
        site_url: "https://example.com",
      },
      "GET /v1/projects\nPOST /v1/projects/{id}/query",
    );

    expect(prompt).toMatch(/SEEDED API OPERATIONS/i);
    expect(prompt).toMatch(/GET \/v1\/projects/);
    expect(prompt).toMatch(/WebFetch https:\/\/docs\.example\.com/);
    expect(prompt).toMatch(/gap-fill/i);
    expect(prompt).toMatch(/Do not stop at the seed alone/i);
    expect(prompt).not.toMatch(/you do NOT need to web-search/i);
    expect(prompt).toMatch(/\["api","sdk","cli"\] ONLY/);
  });

  it("normalizes invented surface labels onto api/sdk/cli", () => {
    expect(normalizeSurfacesDocumented(["sql", "api", "psql"])).toEqual(["api"]);
    expect(normalizeSurfacesDocumented(["sdk", "driver", "cli"])).toEqual(["sdk", "cli"]);
    expect(normalizeSurfacesDocumented(["wire", "console"])).toEqual(["api"]);
  });
});
