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
import { parse as yamlParse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeExtractAdvisory,
  type ExtractAdvisory,
} from "../src/authoring/extract-advisory.js";

const roots: string[] = [];
const advisory: ExtractAdvisory = {
  schema: "ax.extract-advisory/v1",
  vendor: "Acme",
  slug: "acme",
  generated_at: "2026-01-01T00:00:00.000Z",
  findings: [],
};

function freshRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ax-extract-advisory-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("extract advisory writer", () => {
  it("creates a canonical nested advisory through the contained writer", () => {
    const root = freshRoot();
    const path = writeExtractAdvisory(root, advisory);

    expect(path).toBe(resolve(
      root,
      "ax-arena",
      "benchmark",
      "daeb",
      "v1",
      "extracts",
      "acme",
      "advisory.yaml",
    ));
    expect(yamlParse(readFileSync(path, "utf8"))).toEqual(advisory);
  });

  it("rejects a symlinked vendor directory without writing through it", () => {
    const root = freshRoot();
    const extracts = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "extracts");
    const outside = resolve(root, "outside");
    mkdirSync(extracts, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, resolve(extracts, "acme"), "dir");

    expect(() => writeExtractAdvisory(root, advisory)).toThrow(/symlink or non-directory/);
    expect(existsSync(resolve(outside, "advisory.yaml"))).toBe(false);
  });

  it("rejects symlink and hard-link advisory aliases without changing their targets", () => {
    for (const alias of ["symlink", "hardlink"] as const) {
      const root = freshRoot();
      const vendorDir = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "extracts", "acme");
      const outside = resolve(root, "outside.yaml");
      const path = resolve(vendorDir, "advisory.yaml");
      mkdirSync(vendorDir, { recursive: true });
      writeFileSync(outside, "unchanged\n");
      if (alias === "symlink") symlinkSync(outside, path);
      else linkSync(outside, path);

      expect(() => writeExtractAdvisory(root, advisory))
        .toThrow(/regular, single-link non-symlink/);
      expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
    }
  });
});
