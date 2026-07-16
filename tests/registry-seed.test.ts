import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  loadRegistryAuthoringSeed,
  loadRegistryAuthoringSeedPath,
  mapRegistryAuthoringSeed,
  writeRegistryAuthoringSeed,
} from "../src/ingest/registry-seed.js";

const FIXTURE = {
  domain: "Supabase.COM.",
  summary: "Hosted database platform",
  secretValue: "must-not-survive",
  detect: {
    apiCatalog: {
      openapi: ["https://api.supabase.com/openapi.json", "http://127.0.0.1/private.json"],
      docs: ["https://supabase.com/docs/reference/api"],
    },
  },
  credentials: {
    supabase_pat: {
      type: "bearer",
      label: "Personal access token",
      generateUrl: "https://supabase.com/dashboard/account/tokens",
      secretValue: "must-not-survive",
    },
    supabase_oauth: { type: "oauth2" },
  },
  surfaces: [
    {
      type: "http",
      url: "https://api.supabase.com/v1",
      docs: "https://supabase.com/docs/reference/api",
      name: "Management API",
      auth: { status: "required", entries: [{ use: [{ id: "supabase_pat", secretValue: "nope" }] }] },
      basis: { via: "detected", signal: "openapi", evidence: ["https://api.supabase.com/openapi.json"] },
    },
    {
      type: "cli",
      command: "supabase",
      packages: [{ registryType: "homebrew", identifier: "supabase/tap/supabase" }],
      docs: "https://supabase.com/docs/reference/cli",
      auth: { status: "required", entries: [{ use: [{ id: "supabase_pat" }] }] },
    },
    {
      type: "mcp",
      url: "https://mcp.supabase.com/mcp",
      docs: "https://supabase.com/docs/guides/ai-tools/mcp",
      auth: { status: "required", entries: [{ use: [{ id: "supabase_oauth" }] }] },
    },
  ],
};

describe("mapRegistryAuthoringSeed", () => {
  it("maps every candidate without selecting or executing one", () => {
    const seed = mapRegistryAuthoringSeed(FIXTURE, { now: () => new Date("2026-07-16T12:00:00.000Z") });
    expect(seed).toMatchObject({
      schema: "ax.registry-authoring-seed/v1",
      domain: "supabase.com",
      site_url: "https://supabase.com",
      mapped_at: "2026-07-16T12:00:00.000Z",
      openapi_urls: ["https://api.supabase.com/openapi.json"],
    });
    expect(seed.candidates.map((candidate) => candidate.id)).toEqual(["http:1", "cli:2", "mcp:3"]);
    expect(seed.candidates.every((candidate) => candidate.review_required)).toBe(true);
    expect(seed.candidates[1]).toMatchObject({
      command: "supabase",
      packages: [{ registry: "homebrew", identifier: "supabase/tap/supabase" }],
      auth: { kind: "inherit", credential_ref: "credential-1", requires_env_mapping: false },
    });
    expect(seed.candidates[2]).toMatchObject({
      transport: "http",
      auth: { kind: "oauth_app", credential_ref: "credential-2", requires_env_mapping: true },
    });
  });

  it("strips unknown and secret-shaped registry fields", () => {
    const serialized = JSON.stringify(mapRegistryAuthoringSeed(FIXTURE));
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("secretValue");
    expect(serialized).not.toContain("supabase_pat");
    expect(serialized).not.toContain("supabase_oauth");
  });

  it("keeps unsafe commands and private URLs out of the seed", () => {
    const seed = mapRegistryAuthoringSeed({
      domain: "example.com",
      surfaces: [{
        type: "mcp",
        command: "npx package; cat .env",
        url: "http://localhost:3000/mcp",
        docs: "file:///tmp/docs",
      }],
    });
    expect(seed.candidates[0]).toMatchObject({ endpoint: null, docs_url: null, command: null, transport: null });
    expect(seed.warnings).toHaveLength(3);
  });

  it("preserves multiple candidates and flags unsupported types", () => {
    const seed = mapRegistryAuthoringSeed({
      domain: "example.com",
      surfaces: [
        { type: "http", url: "https://api.example.com/v1" },
        { type: "http", url: "https://admin.example.com/v1" },
        { type: "desktop-app", command: "example" },
      ],
    });
    expect(seed.candidates.map((candidate) => candidate.endpoint)).toEqual([
      "https://api.example.com/v1",
      "https://admin.example.com/v1",
    ]);
    expect(seed.warnings).toEqual(["surface 3 has an unsupported type"]);
  });

  it("rejects malformed public domains", () => {
    expect(() => mapRegistryAuthoringSeed({ domain: "localhost", surfaces: [] })).toThrow(/public DNS name/);
    expect(() => mapRegistryAuthoringSeed({ domain: "${DOMAIN}", surfaces: [] })).toThrow(/public DNS name/);
  });

  it("writes and loads a bounded validated seed atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-registry-seed-"));
    try {
      const seed = mapRegistryAuthoringSeed({
        domain: "example.com",
        surfaces: [{ type: "cli", command: "example" }],
      }, { now: () => new Date("2026-01-01T00:00:00.000Z") });
      const path = writeRegistryAuthoringSeed(root, "example", seed);
      expect(path).toContain("targets/seeds/example/registry.yaml");
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(loadRegistryAuthoringSeed(root, "example")).toEqual(seed);
      expect(loadRegistryAuthoringSeed(root, "missing")).toBeNull();
      expect(() => writeRegistryAuthoringSeed(root, "../escape", seed)).toThrow(/vendor slug/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects drifted persisted seed artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-registry-seed-invalid-"));
    try {
      const path = join(root, "invalid.yaml");
      writeFileSync(path, yamlStringify({
        schema: "ax.registry-authoring-seed/v1",
        domain: "example.com",
        site_url: "https://example.com",
        summary: null,
        mapped_at: "2026-01-01T00:00:00.000Z",
        openapi_urls: [],
        docs_urls: [],
        candidates: [{ id: "cli:1", type: "cli", command: "example | sh" }],
        warnings: [],
      }));
      expect(() => loadRegistryAuthoringSeedPath(path)).toThrow(/registry authoring seed/);

      const seed = mapRegistryAuthoringSeed({
        domain: "example.com",
        surfaces: [{ type: "cli", command: "example" }],
      });
      writeFileSync(path, yamlStringify({ ...seed, site_url: "https://other.example" }));
      expect(() => loadRegistryAuthoringSeedPath(path)).toThrow(/registry authoring seed/);

      writeFileSync(path, yamlStringify({
        ...seed,
        candidates: [seed.candidates[0], seed.candidates[0]],
      }));
      expect(() => loadRegistryAuthoringSeedPath(path)).toThrow(/registry authoring seed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
