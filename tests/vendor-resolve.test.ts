import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PROMPT_VERSION,
  loadVendorCard,
  resolveVendor,
  resolveVendors,
  slugify,
  vendorCardPath,
  writeVendorCard,
} from "../src/generate/vendor-resolve.js";

describe("vendor-resolve (v3: llm-search batch)", () => {
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

  it("resolveVendors returns results for all vendors via fixture", async () => {
    const fakeBatch = [
      { vendor: "Supabase", site_url: "https://supabase.com", docs_url: "https://supabase.com/docs" },
      { vendor: "Neon", site_url: "https://neon.tech", docs_url: "https://neon.tech/docs" },
    ];
    writeFileSync(fixturePath, JSON.stringify(fakeBatch));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    const results = await resolveVendors(["Supabase", "Neon"], "database", { harness: "claude-code" });
    expect(results).toHaveLength(2);
    expect(results[0].vendor).toBe("Supabase");
    expect(results[0].docs_url).toBe("https://supabase.com/docs");
    expect(results[0].resolver.method).toBe("llm-search");
    expect(results[0].resolver.prompt_version).toBe(PROMPT_VERSION);
    expect(results[1].vendor).toBe("Neon");
  });

  it("resolveVendor (single) wraps resolveVendors", async () => {
    const fakeBatch = [
      { vendor: "Supabase", site_url: "https://supabase.com", docs_url: "https://supabase.com/docs" },
    ];
    writeFileSync(fixturePath, JSON.stringify(fakeBatch));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    const result = await resolveVendor("Supabase", "database", { harness: "claude-code" });
    expect(result.slug).toBe("supabase");
    expect(result.docs_url).toBe("https://supabase.com/docs");
  });

  it("resolveVendors throws when LLM returns non-conforming JSON", async () => {
    writeFileSync(fixturePath, JSON.stringify({ not: "an array" }));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    await expect(
      resolveVendors(["Supabase"], "database", { harness: "claude-code" }),
    ).rejects.toThrow(/non-conforming JSON/);
  });

  it("writeVendorCard + loadVendorCard round-trip preserves the result", async () => {
    const fakeBatch = [
      { vendor: "ZzzExample99", site_url: "https://example.com", docs_url: "https://example.com/docs" },
    ];
    // NOTE: fixture must be an array (batch schema)
    writeFileSync(fixturePath, JSON.stringify(fakeBatch));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    const result = await resolveVendor("ZzzExample99", "database", { harness: "claude-code" });
    const path = writeVendorCard(tmpRoot, result);
    expect(path).toBe(vendorCardPath(tmpRoot, "zzzexample99"));
    expect(existsSync(path)).toBe(true);

    const loaded = loadVendorCard(tmpRoot, "zzzexample99");
    expect(loaded).not.toBeNull();
    expect(loaded?.vendor).toBe("ZzzExample99");
    expect(loaded?.docs_url).toBe("https://example.com/docs");
  });

  it("loadVendorCard returns null when no card exists", () => {
    expect(loadVendorCard(tmpRoot, "nope")).toBeNull();
  });

  it("loadVendorCard errors on malformed YAML on disk", () => {
    mkdirSync(resolve(tmpRoot, "benchmarks", "daeb", "vendors"), { recursive: true });
    writeFileSync(vendorCardPath(tmpRoot, "bad"), "vendor: Bad\ncategory: db\n");
    expect(() => loadVendorCard(tmpRoot, "bad")).toThrow(/malformed/);
  });
});
