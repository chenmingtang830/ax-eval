import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PROMPT_VERSION,
  candidatePatterns,
  loadVendorCard,
  resolveVendor,
  slugify,
  vendorCardPath,
  writeVendorCard,
} from "../src/generate/vendor-resolve.js";

describe("vendor-resolve (v2: lean docs-only)", () => {
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

  it("candidatePatterns generates the expected URL set", () => {
    const patterns = candidatePatterns("Supabase");
    // Should include the dominant pattern that wins for most vendors.
    expect(patterns).toContain("https://supabase.com/docs");
    expect(patterns).toContain("https://docs.supabase.com");
    expect(patterns).toContain("https://supabase.dev/docs");
    expect(patterns.length).toBeGreaterThan(5);
  });

  it("candidatePatterns strips hyphens when building domains", () => {
    // "MongoDB Atlas" → slug "mongodb-atlas" → domain `mongodbatlas`
    // Not perfect (that domain probably 404s, triggering LLM fallback),
    // but we don't want bogus `mongodb-atlas.com` patterns either.
    const patterns = candidatePatterns("MongoDB Atlas");
    expect(patterns.every((u) => !u.includes("mongodb-atlas"))).toBe(true);
  });

  it("resolveVendor with noLlmFallback throws when no pattern matches", async () => {
    await expect(
      // A nonsense vendor that won't have a 200 response on common patterns.
      resolveVendor("ZzzNonexistentVendor99", "database", { noLlmFallback: true }),
    ).rejects.toThrow(/no URL pattern matched/);
  });

  it("resolveVendor uses LLM fallback when patterns fail and fallback enabled", async () => {
    const fakeLlmOutput = {
      site_url: "https://cockroachlabs.com",
      docs_url: "https://cockroachlabs.com/docs",
    };
    writeFileSync(fixturePath, JSON.stringify(fakeLlmOutput));
    process.env.AX_EVAL_GENERATOR_FIXTURE = fixturePath;

    // Use a vendor that won't hit the URL patterns to force fallback.
    const result = await resolveVendor("ZzzNonexistentVendor99", "database", {
      harness: "claude-code",
    });
    expect(result.resolver.method).toBe("llm-fallback");
    expect(result.site_url).toBe("https://cockroachlabs.com");
    expect(result.docs_url).toBe("https://cockroachlabs.com/docs");
    expect(result.resolver.prompt_version).toBe(PROMPT_VERSION);
  });

  it("writeVendorCard + loadVendorCard round-trip preserves the result", async () => {
    const fakeLlmOutput = {
      site_url: "https://example.com",
      docs_url: "https://example.com/docs",
    };
    writeFileSync(fixturePath, JSON.stringify(fakeLlmOutput));
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
    mkdirSync(resolve(tmpRoot, "targets", "vendors"), { recursive: true });
    writeFileSync(vendorCardPath(tmpRoot, "bad"), "vendor: Bad\ncategory: db\n");
    expect(() => loadVendorCard(tmpRoot, "bad")).toThrow(/malformed/);
  });
});
