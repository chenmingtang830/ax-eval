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
import { afterEach, describe, expect, it } from "vitest";
import { writeExtractAdvisory, type ExtractAdvisory } from "../src/authoring/extract-advisory.js";
import { writeVendorCard } from "../src/authoring/artifact-persistence.js";

const roots: string[] = [];

function fixture(): { root: string; vendorDir: string; outside: string; advisory: ExtractAdvisory } {
  const root = mkdtempSync(resolve(tmpdir(), "ax-arena-writer-"));
  roots.push(root);
  const extracts = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "extracts");
  const vendorDir = resolve(extracts, "vendor");
  const outside = resolve(root, "outside");
  mkdirSync(extracts, { recursive: true });
  mkdirSync(outside);
  return {
    root,
    vendorDir,
    outside,
    advisory: {
      schema: "ax.extract-advisory/v1",
      vendor: "Vendor",
      slug: "vendor",
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical arena artifact writers", () => {
  it("rejects linked and dangling nested symlink parents", () => {
    const { root, vendorDir, outside, advisory } = fixture();
    symlinkSync(outside, vendorDir, "dir");
    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/symlink/);
    expect(existsSync(resolve(outside, "advisory.yaml"))).toBe(false);

    rmSync(vendorDir);
    symlinkSync(resolve(root, "missing"), vendorDir, "dir");
    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/symlink/);
  });

  it("rejects hard-linked output files without changing the outside inode", () => {
    const { root, vendorDir, outside, advisory } = fixture();
    mkdirSync(vendorDir);
    const outsideFile = resolve(outside, "outside.txt");
    const advisoryPath = resolve(vendorDir, "advisory.yaml");
    writeFileSync(outsideFile, "outside-original");
    linkSync(outsideFile, advisoryPath);

    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/single-link/);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside-original");
  });

  it("protects command-owned vendor cards from hard-linked outputs", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-vendor-writer-"));
    roots.push(root);
    const vendorDir = resolve(root, "ax-arena", "benchmark", "daeb", "vendors");
    const outside = resolve(root, "outside.txt");
    const cardPath = resolve(vendorDir, "vendor.discovered.yaml");
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(outside, "outside-original");
    linkSync(outside, cardPath);

    expect(() => writeVendorCard(root, {
      vendor: "Vendor",
      slug: "vendor",
      category: "database",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "official-docs" },
      site_url: "https://vendor.example",
      docs_url: "https://vendor.example/docs",
      http_status: 200,
    })).toThrow(/single-link/);
    expect(readFileSync(outside, "utf8")).toBe("outside-original");
  });
});
