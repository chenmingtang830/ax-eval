import { describe, expect, it } from "vitest";
import { extractSurfaces } from "../src/generate/surface-extract.js";
import { mapRegistryAuthoringSeed } from "../src/ingest/registry-seed.js";
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

  it("uses registry candidates only as review-required hypotheses", async () => {
    const seed = mapRegistryAuthoringSeed({
      domain: "acme.example",
      surfaces: [{
        type: "cli",
        name: "Possibly stale CLI",
        command: "npx @acme/old-cli",
        docs: "https://docs.acme.example/cli",
      }],
    }, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    let prompt = "";
    const result = await extractSurfaces(vendor, {
      registrySeed: seed,
      generate: async (value) => {
        prompt = value;
        return JSON.stringify({
          cli: {
            bin: "acme",
            install: "npm install -g @acme/cli",
            docs_url: "https://docs.acme.example/cli",
            auth: { kind: "inherit" },
          },
          sdk: null,
          mcp: null,
        });
      },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(prompt).toContain("REVIEW-REQUIRED REGISTRY HYPOTHESIS");
    expect(prompt).toContain("Verify every candidate");
    expect(result.cli?.install).toBe("npm install -g @acme/cli");
    expect(result.registry_seed).toEqual({
      domain: "acme.example",
      mapped_at: "2026-01-01T00:00:00.000Z",
      candidate_ids: ["cli:1"],
      content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects mismatched or irrelevant registry seeds before generation", async () => {
    const mismatched = mapRegistryAuthoringSeed({
      domain: "other.example",
      surfaces: [{ type: "cli", command: "other" }],
    });
    await expect(extractSurfaces(vendor, {
      registrySeed: mismatched,
      generate: async () => "should not run",
    })).rejects.toThrow(/does not match/);

    const irrelevant = mapRegistryAuthoringSeed({
      domain: "acme.example",
      surfaces: [{ type: "http", url: "https://acme.example/api" }],
    });
    await expect(extractSurfaces(vendor, {
      registrySeed: irrelevant,
      generate: async () => "should not run",
    })).rejects.toThrow(/no CLI, SDK, or MCP candidates/);

    const oversized = mapRegistryAuthoringSeed({
      domain: "acme.example",
      surfaces: [{
        type: "cli",
        command: "acme",
        basis: { evidence: Array.from({ length: 600 }, (_, index) => `https://docs.acme.example/${"x".repeat(90)}${index}`) },
      }],
    });
    await expect(extractSurfaces(vendor, {
      registrySeed: oversized,
      generate: async () => "should not run",
    })).rejects.toThrow(/exceeds 50000 characters/);
  });
});
