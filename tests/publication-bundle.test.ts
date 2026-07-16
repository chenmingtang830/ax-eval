import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializePublicationBundle } from "../src/generate/publication-bundle.js";
import { buildPublicationManifest } from "../src/generate/publication-manifest.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-publication-"));
  dirs.push(dir);
  return dir;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(root: string) {
  mkdirSync(resolve(root, "source"), { recursive: true });
  writeFileSync(resolve(root, "source", "suite.yaml"), "name: suite\n");
  writeFileSync(resolve(root, "source", "aggregate.json"), "{\"score\":1}\n");
  const manifest = buildPublicationManifest({
    benchmark: "Database Suite",
    category: "database",
    suiteVersion: 1,
    standardSetVersion: "suite-v1",
    vendors: [{ vendor: "acme", surfaces: ["api"] }],
    harnesses: ["codex"],
    requiredProfiles: ["medium"],
    requiredTrialCount: 3,
    artifacts: [{ id: "suite", path: "suite/suite.yaml", sha256: sha256("name: suite\n"), required: true }],
    cells: [{
      vendor: "acme",
      surface: "api",
      harness: "codex",
      profiles: ["medium"],
      trial_count: 3,
      aggregate_record: "vendors/acme/api/codex/aggregate.json",
      aggregate_sha256: sha256("{\"score\":1}\n"),
    }],
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
  return { manifest, files: [
    { source_path: "source/suite.yaml", bundle_path: "suite/suite.yaml" },
    { source_path: "source/aggregate.json", bundle_path: "vendors/acme/api/codex/aggregate.json" },
  ] };
}

describe("materializePublicationBundle", () => {
  it("publishes only explicitly declared files through a staging directory", () => {
    const root = freshDir();
    const { manifest, files } = fixture(root);
    const outRoot = materializePublicationBundle({ root, outDir: "bundle", manifest, files });
    expect(outRoot).toBe(resolve(realpathSync(root), "bundle"));
    expect(readFileSync(resolve(outRoot, "suite", "suite.yaml"), "utf8")).toBe("name: suite\n");
    expect(readFileSync(resolve(outRoot, "vendors", "acme", "api", "codex", "aggregate.json"), "utf8")).toContain("score");
    expect(JSON.parse(readFileSync(resolve(outRoot, "manifest.json"), "utf8"))).toEqual(manifest);
    expect(readdirSync(realpathSync(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects missing, undeclared, duplicate, and secret-bearing destinations", () => {
    const root = freshDir();
    const { manifest, files } = fixture(root);
    expect(() => materializePublicationBundle({ root, outDir: "out-a", manifest, files: files.slice(0, 1) })).toThrow(/missing declared files/);
    expect(() => materializePublicationBundle({
      root,
      outDir: "out-b",
      manifest,
      files: [...files, { source_path: "source/suite.yaml", bundle_path: "extra.txt" }],
    })).toThrow(/undeclared files/);
    expect(() => materializePublicationBundle({ root, outDir: "out-c", manifest, files: [files[0]!, files[0]!] })).toThrow(/duplicate destination/);
    expect(() => materializePublicationBundle({
      root,
      outDir: "out-missing-digest",
      manifest: { ...manifest, artifacts: manifest.artifacts.map(({ sha256: _sha256, ...artifact }) => artifact) },
      files,
    })).toThrow(/missing SHA-256 digests/);
    expect(() => materializePublicationBundle({
      root,
      outDir: "out-invalid-digest",
      manifest: { ...manifest, artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, sha256: "bad" })) },
      files,
    })).toThrow(/invalid SHA-256 digest/);
    expect(() => materializePublicationBundle({
      root,
      outDir: "out-d",
      manifest: { ...manifest, artifacts: [{ id: "suite", path: ".env", required: true }] },
      files: [{ source_path: "source/suite.yaml", bundle_path: ".env" }, files[1]!],
    })).toThrow(/not publishable/);
  });

  it("rejects content that does not match the manifest digest", () => {
    const root = freshDir();
    const { manifest, files } = fixture(root);
    writeFileSync(resolve(root, "source", "aggregate.json"), "{\"score\":0}\n");
    expect(() => materializePublicationBundle({ root, outDir: "bundle", manifest, files })).toThrow(/digest mismatch/);
    expect(existsSync(resolve(root, "bundle"))).toBe(false);
  });

  it("rejects source symlink escapes and never overwrites an existing bundle", () => {
    const root = freshDir();
    const outside = freshDir();
    const { manifest, files } = fixture(root);
    writeFileSync(resolve(outside, "outside.json"), "{}\n");
    symlinkSync(resolve(outside, "outside.json"), resolve(root, "source", "linked.json"));
    expect(() => materializePublicationBundle({
      root,
      outDir: "out-a",
      manifest,
      files: [files[0]!, { source_path: "source/linked.json", bundle_path: files[1]!.bundle_path }],
    })).toThrow(/inside the source root/);

    symlinkSync(outside, resolve(root, "outside-link"));
    expect(() => materializePublicationBundle({
      root,
      outDir: "outside-link/bundle",
      manifest,
      files,
    })).toThrow(/output directory must stay inside/);

    mkdirSync(resolve(root, "existing"));
    writeFileSync(resolve(root, "existing", "keep.txt"), "keep\n");
    expect(() => materializePublicationBundle({ root, outDir: "existing", manifest, files })).toThrow(/already exists/);
    expect(readFileSync(resolve(root, "existing", "keep.txt"), "utf8")).toBe("keep\n");
  });
});
