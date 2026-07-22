import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DAEB_BENCHMARK_ROOT,
  DAEB_LEGACY_BENCHMARK_ROOT,
  assertCanonicalDaebWritePath,
  createDaebPathContext,
  daebReadSuitePath,
  daebSuitePath,
  daebVendorCardPath,
  daebVersionDir,
  resolveDaebBenchmarkRoot,
  type DaebPathContext,
} from "../src/generate/benchmark-paths.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ax-daeb-paths-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DAEB benchmark root compatibility", () => {
  it("prefers the canonical root when it is the only root present", () => {
    const root = freshRoot();
    const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
    mkdirSync(canonical, { recursive: true });

    expect(resolveDaebBenchmarkRoot(root, { access: "read" })).toBe(canonical);
  });

  it("reads the legacy root with a deprecation warning when canonical is absent", () => {
    const root = freshRoot();
    const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
    mkdirSync(legacy, { recursive: true });
    const warnings: string[] = [];

    expect(resolveDaebBenchmarkRoot(root, { access: "read", warn: (message) => warnings.push(message) }))
      .toBe(legacy);
    expect(warnings).toEqual([expect.stringMatching(/deprecated benchmark root.*one minor release/)]);
  });

  it("fails ambiguous implicit reads and accepts an explicit root", () => {
    const root = freshRoot();
    const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
    const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });

    expect(() => resolveDaebBenchmarkRoot(root, { access: "read" }))
      .toThrow(/ambiguous benchmark roots.*--benchmark-root/);
    expect(resolveDaebBenchmarkRoot(root, { access: "read", explicitRoot: DAEB_BENCHMARK_ROOT }))
      .toBe(canonical);
    const warnings: string[] = [];
    expect(resolveDaebBenchmarkRoot(root, {
      access: "read",
      explicitRoot: legacy,
      warn: (message) => warnings.push(message),
    }))
      .toBe(legacy);
    expect(warnings).toEqual([expect.stringMatching(/deprecated benchmark root/)]);
    expect(() => assertCanonicalDaebWritePath(root, resolve(canonical, "v1", "suite.yaml")))
      .toThrow(/ambiguous benchmark roots/);
    const explicit = createDaebPathContext(root, { explicitRoot: DAEB_BENCHMARK_ROOT });
    expect(assertCanonicalDaebWritePath(explicit, resolve(canonical, "v1", "suite.yaml")))
      .toBe(resolve(canonical, "v1", "suite.yaml"));
  });

  it("routes every write to canonical and rejects an explicit legacy write root", () => {
    const root = freshRoot();
    const canonical = resolve(root, DAEB_BENCHMARK_ROOT);

    expect(resolveDaebBenchmarkRoot(root, { access: "write" })).toBe(canonical);
    expect(() => resolveDaebBenchmarkRoot(root, {
      access: "write",
      explicitRoot: DAEB_LEGACY_BENCHMARK_ROOT,
    })).toThrow(/writers use only the canonical benchmark root/);
    expect(assertCanonicalDaebWritePath(root, "ax-arena/benchmark/daeb/v1/suite.yaml"))
      .toBe(resolve(canonical, "v1", "suite.yaml"));
    expect(() => assertCanonicalDaebWritePath(root, "benchmarks/daeb/v1/suite.yaml"))
      .toThrow(/writers use only the canonical benchmark root/);
    expect(() => assertCanonicalDaebWritePath(root, "../outside.yaml"))
      .toThrow(/writers use only the canonical benchmark root/);
  });

  it("defaults absent roots to canonical and keeps legacy reads separate from canonical writes", () => {
    const root = freshRoot();
    expect(resolveDaebBenchmarkRoot(root, { access: "read" })).toBe(resolve(root, DAEB_BENCHMARK_ROOT));

    const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
    mkdirSync(legacy, { recursive: true });
    const context = createDaebPathContext(root, { warn: () => {} });
    expect(daebReadSuitePath(context)).toBe(resolve(legacy, "v1", "suite.yaml"));
    expect(daebSuitePath(context)).toBe(resolve(root, DAEB_BENCHMARK_ROOT, "v1", "suite.yaml"));
  });

  it("rejects symlinked benchmark roots", () => {
    const root = freshRoot();
    const target = resolve(root, "target");
    mkdirSync(target);
    mkdirSync(resolve(root, "ax-arena", "benchmark"), { recursive: true });
    symlinkSync(target, resolve(root, DAEB_BENCHMARK_ROOT), "dir");

    expect(() => resolveDaebBenchmarkRoot(root, { access: "read" }))
      .toThrow(/symlink/);
  });

  it("rejects dangling benchmark-root symlinks", () => {
    const root = freshRoot();
    mkdirSync(resolve(root, "ax-arena", "benchmark"), { recursive: true });
    symlinkSync(resolve(root, "missing-target"), resolve(root, DAEB_BENCHMARK_ROOT), "dir");

    expect(() => resolveDaebBenchmarkRoot(root, { access: "read" }))
      .toThrow(/symlink/);
  });

  it("rejects intermediate and dangling ancestor symlinks", () => {
    for (const mode of ["linked", "dangling"] as const) {
      const root = freshRoot();
      const target = resolve(root, "target");
      if (mode === "linked") mkdirSync(resolve(target, "benchmark", "daeb"), { recursive: true });
      symlinkSync(mode === "linked" ? target : resolve(root, "missing"), resolve(root, "ax-arena"), "dir");
      expect(() => resolveDaebBenchmarkRoot(root, { access: "read" })).toThrow(/symlink/);
    }
  });

  it("rejects nested symlinks in canonical writer parents", () => {
    const root = freshRoot();
    const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
    const outside = resolve(root, "outside");
    mkdirSync(resolve(canonical, "v1"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, resolve(canonical, "v1", "packs"), "dir");

    expect(() => assertCanonicalDaebWritePath(
      root,
      resolve(canonical, "v1", "packs", "vendor", "pack.yaml"),
    )).toThrow(/cannot traverse a symlink/);
  });

  it("rejects structurally forged path contexts", () => {
    const root = freshRoot();
    const forged = {
      repositoryRoot: root,
      readRoot: resolve(root, "outside"),
      writeRoot: resolve(root, DAEB_BENCHMARK_ROOT),
      explicitReadRoot: true,
      readRootKind: "explicit",
    } as unknown as DaebPathContext;
    expect(() => daebReadSuitePath(forged)).toThrow(/created by createDaebPathContext/);
  });

  it("rejects traversal in slug- and version-derived paths", () => {
    const root = freshRoot();
    expect(() => daebVendorCardPath(root, "../outside"))
      .toThrow(/vendor slug must be a single safe path segment/);
    expect(() => daebVendorCardPath(root, "/tmp/outside"))
      .toThrow(/vendor slug must be a single safe path segment/);
    expect(() => daebVersionDir(root, "../v1"))
      .toThrow(/benchmark version must be a single safe path segment/);
  });
});
