import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AXARENA_DATABASE_BENCHMARK_ROOT,
  AXARENA_DATABASE_LEGACY_ARENA_ROOT,
  AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT,
  assertCanonicalAxArenaDatabaseSuiteWritePath,
  assertCanonicalAxArenaDatabaseWritePath,
  createAxArenaDatabasePathContext,
  axArenaDatabaseReadSuitePath,
  axArenaDatabaseSuitePath,
  axArenaDatabaseVendorCardPath,
  axArenaDatabaseVersionDir,
  resolveAxArenaDatabaseBenchmarkRoot,
  type AxArenaDatabasePathContext,
} from "../src/authoring/benchmark-paths.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "axarena-database-paths-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AXArena-Database benchmark root compatibility", () => {
  it("prefers the canonical root when it is the only root present", () => {
    const root = freshRoot();
    const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);
    mkdirSync(canonical, { recursive: true });

    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" })).toBe(canonical);
  });

  it("reads the legacy root with a deprecation warning when canonical is absent", () => {
    const root = freshRoot();
    const legacy = resolve(root, AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT);
    mkdirSync(resolve(legacy, "v1"), { recursive: true });
    writeFileSync(resolve(legacy, "v1", "suite.yaml"), "name: legacy\n");
    const warnings: string[] = [];

    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read", warn: (message) => warnings.push(message) }))
      .toBe(legacy);
    expect(warnings).toEqual([expect.stringMatching(/deprecated benchmark root.*one minor release/)]);
  });

  it("reads the former arena root as a deprecated compatibility path", () => {
    const root = freshRoot();
    const legacy = resolve(root, AXARENA_DATABASE_LEGACY_ARENA_ROOT);
    mkdirSync(resolve(legacy, "v1"), { recursive: true });
    writeFileSync(resolve(legacy, "v1", "suite.yaml"), "name: legacy\n");
    const warnings: string[] = [];

    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read", warn: (message) => warnings.push(message) }))
      .toBe(legacy);
    expect(warnings).toEqual([expect.stringMatching(/deprecated benchmark root/)]);
  });

  it("fails ambiguous implicit reads and accepts an explicit root", () => {
    const root = freshRoot();
    const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);
    const legacy = resolve(root, AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT);
    mkdirSync(canonical, { recursive: true });
    mkdirSync(resolve(legacy, "v1"), { recursive: true });
    writeFileSync(resolve(legacy, "v1", "suite.yaml"), "name: legacy\n");

    expect(() => resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" }))
      .toThrow(/ambiguous benchmark roots.*--benchmark-root/);
    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read", explicitRoot: AXARENA_DATABASE_BENCHMARK_ROOT }))
      .toBe(canonical);
    const warnings: string[] = [];
    expect(resolveAxArenaDatabaseBenchmarkRoot(root, {
      access: "read",
      explicitRoot: legacy,
      warn: (message) => warnings.push(message),
    }))
      .toBe(legacy);
    expect(warnings).toEqual([expect.stringMatching(/deprecated benchmark root/)]);
    expect(() => assertCanonicalAxArenaDatabaseWritePath(root, resolve(canonical, "v1", "suite.yaml")))
      .toThrow(/ambiguous benchmark roots/);
    const explicit = createAxArenaDatabasePathContext(root, { explicitRoot: AXARENA_DATABASE_BENCHMARK_ROOT });
    expect(assertCanonicalAxArenaDatabaseWritePath(explicit, resolve(canonical, "v1", "suite.yaml")))
      .toBe(resolve(canonical, "v1", "suite.yaml"));
  });

  it("preserves an explicitly selected read root outside the repository", () => {
    const root = freshRoot();
    const outside = freshRoot();
    const context = createAxArenaDatabasePathContext(root, { explicitRoot: outside });
    expect(axArenaDatabaseReadSuitePath(context)).toBe(resolve(outside, "v1", "suite.yaml"));
    expect(axArenaDatabaseSuitePath(context)).toBe(resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT, "v1", "suite.yaml"));
  });

  it("routes every write to canonical and rejects an explicit legacy write root", () => {
    const root = freshRoot();
    const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);

    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "write" })).toBe(canonical);
    expect(() => resolveAxArenaDatabaseBenchmarkRoot(root, {
      access: "write",
      explicitRoot: AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT,
    })).toThrow(/writers use only the canonical benchmark root/);
    expect(assertCanonicalAxArenaDatabaseWritePath(root, "ax-arena/benchmark/axarena-database/v1/suite.yaml"))
      .toBe(resolve(canonical, "v1", "suite.yaml"));
    expect(() => assertCanonicalAxArenaDatabaseWritePath(root, "benchmarks/daeb/v1/suite.yaml"))
      .toThrow(/writers use only the canonical benchmark root/);
    expect(() => assertCanonicalAxArenaDatabaseWritePath(root, "../outside.yaml"))
      .toThrow(/writers use only the canonical benchmark root/);
    expect(assertCanonicalAxArenaDatabaseSuiteWritePath(root, "ax-arena/benchmark/axarena-database/v1/suite.yaml"))
      .toBe(resolve(canonical, "v1", "suite.yaml"));
    expect(() => assertCanonicalAxArenaDatabaseSuiteWritePath(root, "ax-arena/benchmark/axarena-database/v1/suite.YAML"))
      .toThrow(/canonical lowercase \.yaml/);
    expect(() => assertCanonicalAxArenaDatabaseSuiteWritePath(root, "ax-arena/benchmark/axarena-database/v1/suite.yml"))
      .toThrow(/canonical lowercase \.yaml/);
  });

  it("defaults absent roots to canonical and keeps legacy reads separate from canonical writes", () => {
    const root = freshRoot();
    expect(resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" })).toBe(resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT));

    const legacy = resolve(root, AXARENA_DATABASE_LEGACY_BENCHMARK_ROOT);
    mkdirSync(resolve(legacy, "v1"), { recursive: true });
    writeFileSync(resolve(legacy, "v1", "suite.yaml"), "name: legacy\n");
    const context = createAxArenaDatabasePathContext(root, { warn: () => {} });
    expect(axArenaDatabaseReadSuitePath(context)).toBe(resolve(legacy, "v1", "suite.yaml"));
    expect(axArenaDatabaseSuitePath(context)).toBe(resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT, "v1", "suite.yaml"));
  });

  it("rejects symlinked benchmark roots", () => {
    const root = freshRoot();
    const target = resolve(root, "target");
    mkdirSync(target);
    mkdirSync(resolve(root, "ax-arena", "benchmark"), { recursive: true });
    symlinkSync(target, resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT), "dir");

    expect(() => resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" }))
      .toThrow(/symlink/);
  });

  it("rejects dangling benchmark-root symlinks", () => {
    const root = freshRoot();
    mkdirSync(resolve(root, "ax-arena", "benchmark"), { recursive: true });
    symlinkSync(resolve(root, "missing-target"), resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT), "dir");

    expect(() => resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" }))
      .toThrow(/symlink/);
  });

  it("rejects intermediate and dangling ancestor symlinks", () => {
    for (const mode of ["linked", "dangling"] as const) {
      const root = freshRoot();
      const target = resolve(root, "target");
      if (mode === "linked") mkdirSync(resolve(target, "benchmark", "axarena-database"), { recursive: true });
      symlinkSync(mode === "linked" ? target : resolve(root, "missing"), resolve(root, "ax-arena"), "dir");
      expect(() => resolveAxArenaDatabaseBenchmarkRoot(root, { access: "read" })).toThrow(/symlink/);
    }
  });

  it("rejects nested symlinks in canonical writer parents", () => {
    const root = freshRoot();
    const canonical = resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT);
    const outside = resolve(root, "outside");
    mkdirSync(resolve(canonical, "v1"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, resolve(canonical, "v1", "packs"), "dir");

    expect(() => assertCanonicalAxArenaDatabaseWritePath(
      root,
      resolve(canonical, "v1", "packs", "vendor", "pack.yaml"),
    )).toThrow(/cannot traverse a symlink/);
  });
  it("rejects structurally forged path contexts", () => {
    const root = freshRoot();
    const forged = {
      repositoryRoot: root,
      readRoot: resolve(root, "outside"),
      writeRoot: resolve(root, AXARENA_DATABASE_BENCHMARK_ROOT),
      explicitReadRoot: true,
      readRootKind: "explicit",
    } as unknown as AxArenaDatabasePathContext;
    expect(() => axArenaDatabaseReadSuitePath(forged)).toThrow(/created by createAxArenaDatabasePathContext/);
  });

  it("rejects traversal in slug- and version-derived paths", () => {
    const root = freshRoot();
    expect(() => axArenaDatabaseVendorCardPath(root, "../outside"))
      .toThrow(/vendor slug must be a single safe path segment/);
    expect(() => axArenaDatabaseVendorCardPath(root, "/tmp/outside"))
      .toThrow(/vendor slug must be a single safe path segment/);
    expect(() => axArenaDatabaseVersionDir(root, "../v1"))
      .toThrow(/benchmark version must be a single safe path segment/);
  });
});
