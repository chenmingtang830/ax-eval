import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExtractAdvisory, type ExtractAdvisory } from "../src/generate/extract-advisory.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("extract advisory writer", () => {
  it("rejects linked and dangling canonical parent symlinks", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-advisory-writer-"));
    roots.push(root);
    const extracts = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "extracts");
    const vendorDir = resolve(extracts, "vendor");
    const outside = resolve(root, "outside");
    mkdirSync(extracts, { recursive: true });
    mkdirSync(outside);
    const advisory: ExtractAdvisory = {
      schema: "ax.extract-advisory/v1",
      vendor: "Vendor",
      slug: "vendor",
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
    };

    symlinkSync(outside, vendorDir, "dir");
    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/symlink/);
    expect(existsSync(resolve(outside, "advisory.yaml"))).toBe(false);

    rmSync(vendorDir);
    symlinkSync(resolve(root, "missing"), vendorDir, "dir");
    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/symlink/);
  });
});
