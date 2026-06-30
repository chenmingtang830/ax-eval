import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PROMPT_VERSION,
  buildResolvePrompt,
  loadVendorCard,
  resolveVendor,
  slugify,
  vendorCardPath,
  writeVendorCard,
} from "../src/generate/vendor-resolve.js";

describe("vendor-resolve", () => {
  let tmpRoot: string;
  let fixturePath: string;
  const prevFixture = process.env.AX_EVAL_GENERATOR_FIXTURE;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "axarena-vr-"));
    fixturePath = resolve(tmpRoot, "fixture.json");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (prevFixture === undefined) delete process.env.AX_EVAL_GENERATOR_FIXTURE;
    else process.env.AX_EVAL_GENERATOR_FIXTURE = prevFixture;
  });

  it("slugifies cleanly", () => {
    expect(slugify("Supabase")).toBe("supabase");
    expect(slugify("MongoDB Atlas")).toBe("mongodb-atlas");
    expect(slugify("CockroachDB Cloud!")).toBe("cockroachdb-cloud");
    expect(slugify("  ---weird-- name---")).toBe("weird-name");
  });

  it("buildResolvePrompt names the vendor + category and lists every JSON key", () => {
    const prompt = buildResolvePrompt("Supabase", "database");
    expect(prompt).toContain("Supabase");
    expect(prompt).toContain("database");
    for (const key of [
      "site_url",
      "docs_urls",
      "openapi_url",
      "graphql_endpoint",
      "sdk_package",
      "sdk_language",
      "cli_bin",
      "cli_install",
      "mcp_url",
      "auth_scheme",
      "notes",
    ]) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toMatch(/Output JSON ONLY/);
  });

  it("resolveVendor parses a conforming fixture, no verification when skipVerify=true", async () => {
    const fakeLlmOutput = {
      site_url: "https://supabase.com",
      docs_urls: ["https://supabase.com/docs/reference/api"],
      openapi_url: "https://api.supabase.com/api/v1/openapi.json",
      graphql_endpoint: null,
      sdk_package: "@supabase/supabase-js",
      sdk_language: "node",
      cli_bin: "supabase",
      cli_install: "brew install supabase/tap/supabase",
      mcp_url: "https://mcp.supabase.com",
      auth_scheme: "Bearer personal access token",
      notes: ["Management API spec is embedded in Swagger UI HTML."],
    };
    writeFileSync(fixturePath, JSON.stringify(fakeLlmOutput));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    const result = await resolveVendor("Supabase", "database", {
      harness: "claude-code",
      skipVerify: true,
    });

    expect(result.vendor).toBe("Supabase");
    expect(result.category).toBe("database");
    expect(result.slug).toBe("supabase");
    expect(result.site_url).toBe("https://supabase.com");
    expect(result.sdk_package).toBe("@supabase/supabase-js");
    expect(result.mcp_url).toBe("https://mcp.supabase.com");
    expect(result.resolver.prompt_version).toBe(PROMPT_VERSION);
    expect(Object.keys(result.verification)).toHaveLength(0); // skipVerify
    expect(result.discovered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("resolveVendor errors loudly on malformed LLM output", async () => {
    // missing several required keys (docs_urls / mcp_url etc.)
    writeFileSync(fixturePath, JSON.stringify({ site_url: "https://example.com" }));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;
    await expect(
      resolveVendor("Whatever", "database", { harness: "claude-code", skipVerify: true }),
    ).rejects.toThrow(/non-conforming object/);
  });

  it("writeVendorCard + loadVendorCard round-trip preserves the result", async () => {
    const fakeLlmOutput = {
      site_url: "https://neon.tech",
      docs_urls: ["https://neon.tech/docs"],
      openapi_url: null,
      graphql_endpoint: null,
      sdk_package: "@neondatabase/serverless",
      sdk_language: "node",
      cli_bin: "neonctl",
      cli_install: "npm i -g neonctl",
      mcp_url: "https://mcp.neon.tech",
      auth_scheme: "Bearer API key",
      notes: [],
    };
    writeFileSync(fixturePath, JSON.stringify(fakeLlmOutput));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    const result = await resolveVendor("Neon", "database", {
      harness: "claude-code",
      skipVerify: true,
    });
    const path = writeVendorCard(tmpRoot, result);
    expect(path).toBe(vendorCardPath(tmpRoot, "neon"));
    expect(existsSync(path)).toBe(true);

    const loaded = loadVendorCard(tmpRoot, "neon");
    expect(loaded).not.toBeNull();
    expect(loaded?.vendor).toBe("Neon");
    expect(loaded?.sdk_package).toBe("@neondatabase/serverless");
    expect(loaded?.mcp_url).toBe("https://mcp.neon.tech");
  });

  it("loadVendorCard returns null when no card exists", () => {
    expect(loadVendorCard(tmpRoot, "nope")).toBeNull();
  });

  it("loadVendorCard errors on malformed YAML on disk", () => {
    mkdirSync(resolve(tmpRoot, "targets", "vendors"), { recursive: true });
    writeFileSync(vendorCardPath(tmpRoot, "bad"), "vendor: Bad\ncategory: db\n");
    expect(() => loadVendorCard(tmpRoot, "bad")).toThrow(/malformed/);
  });
});
