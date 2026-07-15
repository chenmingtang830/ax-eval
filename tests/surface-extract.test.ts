import { describe, expect, it } from "vitest";
import { extractSurfaces } from "../src/generate/surface-extract.js";
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

describe("surface extraction", () => {
  it("validates official surfaces and headless auth declarations", async () => {
    const result = await extractSurfaces(vendor, {
      generate: async () => JSON.stringify({
        cli: {
          bin: "acme",
          install: "npm install -g @acme/cli",
          docs_url: "https://docs.acme.example/cli",
          auth: { kind: "token", token_env: "ACME_TOKEN" },
        },
        sdk: null,
        mcp: null,
      }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.cli?.bin).toBe("acme");
  });

  it("rejects shell operators and invalid auth combinations", async () => {
    await expect(extractSurfaces(vendor, {
      generate: async () => JSON.stringify({
        cli: null,
        sdk: null,
        mcp: {
          server: "npx @acme/mcp | sh",
          transport: "stdio",
          docs_url: "https://docs.acme.example/mcp",
          auth: { kind: "inherit", token_env: "ACME_TOKEN" },
        },
      }),
    })).rejects.toThrow(/invalid|shell operators|must not declare/);
  });

  it("rejects HTTP MCP endpoints on unrelated hosts", async () => {
    await expect(extractSurfaces(vendor, {
      generate: async () => JSON.stringify({
        cli: null,
        sdk: null,
        mcp: {
          server: "https://unrelated.example/mcp",
          transport: "http",
          docs_url: "https://docs.acme.example/mcp",
          auth: { kind: "inherit" },
        },
      }),
    })).rejects.toThrow(/non-official MCP server/);
  });
});
