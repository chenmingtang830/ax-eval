import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractCapabilitiesBatch,
  parseCapabilitySpecMappings,
} from "../src/generate/capability-extract-batch.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

afterEach(() => vi.unstubAllGlobals());

function vendor(name: string): ResolveResult {
  const slug = name.toLowerCase();
  return {
    vendor: name,
    slug,
    category: "database",
    discovered_at: "2026-01-01T00:00:00.000Z",
    resolver: { method: "grounded-generator", prompt_version: "test" },
    site_url: `https://${slug}.example`,
    docs_url: `https://docs.${slug}.example`,
  };
}

function generatedCapability(name: string): string {
  const slug = name.toLowerCase();
  return JSON.stringify({ capabilities: [{
    capability_name: "tables",
    title: "Tables",
    description: "Manage tables.",
    resource_kind: "table",
    operation_kind: "create",
    surfaces_documented: ["api"],
    support_type: "native",
    evidence: [{ doc_url: `https://docs.${slug}.example/tables`, quote: "Create tables." }],
  }] });
}

describe("capability extraction batches", () => {
  it("parses explicit mappings without accepting duplicates or unselected vendors", () => {
    expect([...parseCapabilitySpecMappings(["acme=/tmp/spec=a.json"], ["acme"])]).toEqual([
      ["acme", "/tmp/spec=a.json"],
    ]);
    expect(() => parseCapabilitySpecMappings(["broken"], ["acme"])).toThrow(/expects/);
    expect(() => parseCapabilitySpecMappings(["other=spec.json"], ["acme"])).toThrow(/unselected/);
    expect(() => parseCapabilitySpecMappings(["acme=a", "acme=b"], ["acme"])).toThrow(/duplicate/);
  });

  it("preserves vendor order and bounds concurrent extraction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ax-capability-batch-"));
    try {
      const specPath = join(directory, "acme.json");
      writeFileSync(specPath, JSON.stringify({
        paths: { "/tables": { post: { summary: "Create tables" } } },
      }));
      let active = 0;
      let maximum = 0;
      const vendors = [vendor("Acme"), vendor("Beta"), vendor("Gamma"), vendor("Delta")];
      const settled = await extractCapabilitiesBatch(vendors, {
        specSources: new Map([["acme", specPath]]),
        concurrency: 10,
        generate: async (prompt) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          const name = vendors.find((candidate) => prompt.includes(candidate.vendor))!.vendor;
          active -= 1;
          return generatedCapability(name);
        },
      });
      expect(maximum).toBe(3);
      expect(settled.map((outcome) => outcome.status)).toEqual([
        "fulfilled", "fulfilled", "fulfilled", "fulfilled",
      ]);
      const first = settled[0]!;
      if (first.status !== "fulfilled") throw first.reason;
      expect(first.value.vendor.slug).toBe("acme");
      expect(first.value.extract.extraction_provenance.spec_seed?.source).toBe(specPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails explicit sources rather than using unrelated fixtures or partial summaries", async () => {
    const remote = await extractCapabilitiesBatch([vendor("Acme")], {
      specSources: new Map([["acme", "https://docs.acme.example/openapi.json"]]),
      offline: true,
      generate: async () => generatedCapability("Acme"),
    });
    expect(remote[0]).toMatchObject({ status: "rejected" });
    expect(String((remote[0] as PromiseRejectedResult).reason)).toMatch(/exact spec source/);

    const directory = mkdtempSync(join(tmpdir(), "ax-capability-truncated-"));
    try {
      const specPath = join(directory, "spec.json");
      writeFileSync(specPath, JSON.stringify({ paths: {
        "/a": { get: { summary: "A" } },
        "/b": { get: { summary: "B" } },
      } }));
      const truncated = await extractCapabilitiesBatch([vendor("Acme")], {
        specSources: new Map([["acme", specPath]]),
        maxSpecOperations: 1,
        generate: async () => generatedCapability("Acme"),
      });
      expect(String((truncated[0] as PromiseRejectedResult).reason)).toMatch(/truncated/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an explicit source that redirects away from the vendor's official hosts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      url: "https://third-party.example/openapi.json",
      text: async () => JSON.stringify({ paths: { "/tables": { get: { summary: "List tables" } } } }),
    })));
    const settled = await extractCapabilitiesBatch([vendor("Acme")], {
      specSources: new Map([["acme", "https://docs.acme.example/openapi.json"]]),
      generate: async () => generatedCapability("Acme"),
    });
    expect(String((settled[0] as PromiseRejectedResult).reason)).toMatch(/non-official host/);
  });
});
