import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResolveResultSchema } from "ax-eval";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadVendorCard,
  vendorCardPath,
  writeVendorCard,
} from "../src/authoring/artifact-persistence.js";

describe("arena vendor-card persistence", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "ax-arena-vendor-card-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips a resolved vendor card", () => {
    const card = ResolveResultSchema.parse({
      vendor: "ZzzExample99",
      category: "database",
      slug: "zzzexample99",
      discovered_at: "2026-07-22T00:00:00.000Z",
      resolver: { method: "official-docs" },
      site_url: "https://example.com",
      docs_url: "https://example.com/docs",
      http_status: 200,
    });
    const path = writeVendorCard(root, card);
    expect(path).toBe(vendorCardPath(root, "zzzexample99"));
    expect(existsSync(path)).toBe(true);
    expect(loadVendorCard(root, "zzzexample99")).toEqual(card);
  });

  it("returns null for a missing card and rejects malformed YAML", () => {
    expect(loadVendorCard(root, "nope")).toBeNull();
    mkdirSync(resolve(root, "ax-arena", "benchmark", "daeb", "vendors"), { recursive: true });
    writeFileSync(vendorCardPath(root, "bad"), "vendor: Bad\ncategory: db\n");
    expect(() => loadVendorCard(root, "bad")).toThrow(/malformed/);
  });

  it("rejects symlinked and hard-linked cards without modifying outside bytes", () => {
    const card = ResolveResultSchema.parse({
      vendor: "Acme",
      category: "database",
      slug: "acme",
      discovered_at: "2026-07-22T00:00:00.000Z",
      resolver: { method: "official-docs" },
      site_url: "https://example.com",
      docs_url: "https://example.com/docs",
      http_status: 200,
    });
    for (const mode of ["symlink", "hard-link"] as const) {
      const aliasRoot = mkdtempSync(resolve(tmpdir(), `ax-arena-vendor-${mode}-`));
      const outsideRoot = mkdtempSync(resolve(tmpdir(), `ax-arena-vendor-${mode}-outside-`));
      const outside = resolve(outsideRoot, "outside.yaml");
      writeFileSync(outside, "outside remains unchanged\n");
      try {
        const path = vendorCardPath(aliasRoot, "acme");
        mkdirSync(resolve(path, ".."), { recursive: true });
        if (mode === "symlink") symlinkSync(outside, path);
        else linkSync(outside, path);
        expect(() => loadVendorCard(aliasRoot, "acme")).toThrow(/symlink|single-link/);
        expect(() => writeVendorCard(aliasRoot, card)).toThrow(/symlink|single-link/);
        expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
      } finally {
        rmSync(aliasRoot, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  });
});
