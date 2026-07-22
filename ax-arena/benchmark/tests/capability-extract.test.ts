import { describe, expect, it } from "vitest";
import { ResolveResultSchema, buildCapabilityPrompt, normalizeSurfacesDocumented } from "ax-eval";
import { DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS } from "../src/authoring/database-policy.js";

describe("capability extraction prompt", () => {
  const databaseVendor = () => ResolveResultSchema.parse({
    vendor: "AcmeDB",
    slug: "acmedb",
    category: "database",
    discovered_at: "2026-01-01T00:00:00.000Z",
    resolver: { method: "official-docs" },
    docs_url: "https://docs.example.com",
    site_url: "https://example.com",
    http_status: 200,
  });

  it("requires baseline database ops in the inventory contract", () => {
    const prompt = buildCapabilityPrompt(databaseVendor(), undefined, DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS);

    expect(prompt).toMatch(/baseline operational capabilities/i);
    expect(prompt).toMatch(/Do not over-index/i);
    expect(prompt).toMatch(/When docs expose SQL/i);
    expect(prompt).toMatch(/create table\/collection/i);
    expect(prompt).toMatch(/insert rows\/documents/i);
    expect(prompt).toMatch(/filtered reads\/querying/i);
    expect(prompt).toMatch(/schema introspection/i);
    expect(prompt).toMatch(/tracked schema changes/i);
    expect(prompt).toMatch(/Coverage checklist to close before you stop:/);
  });

  it("keeps core prompting category-neutral until the arena injects policy", () => {
    const prompt = buildCapabilityPrompt(databaseVendor());
    expect(prompt).not.toMatch(/Coverage checklist to close before you stop:/);
    expect(prompt).not.toMatch(/baseline operational capabilities/i);
    expect(prompt).not.toMatch(/When docs expose SQL/i);
  });

  it("seeds from OpenAPI ops but still requires WebFetch gap-fill", () => {
    const prompt = buildCapabilityPrompt(
      databaseVendor(),
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
