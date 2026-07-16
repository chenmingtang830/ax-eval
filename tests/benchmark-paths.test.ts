import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  benchmarkVendorExtractDir,
  buildBenchmarkLayout,
} from "../src/generate/benchmark-paths.js";

describe("benchmark paths", () => {
  it("builds an explicit benchmark and version layout", () => {
    const layout = buildBenchmarkLayout("/repo", "daeb", "v1");
    expect(layout).toEqual({
      root: resolve("/repo"),
      benchmark: "daeb",
      version: "v1",
      benchmark_dir: resolve("/repo", "benchmarks", "daeb"),
      version_dir: resolve("/repo", "benchmarks", "daeb", "v1"),
      vendors_dir: resolve("/repo", "benchmarks", "daeb", "vendors"),
      extracts_dir: resolve("/repo", "benchmarks", "daeb", "v1", "extracts"),
      packs_dir: resolve("/repo", "benchmarks", "daeb", "v1", "packs"),
      archive_dir: resolve("/repo", "benchmarks", "daeb", "_archive"),
      suite_path: resolve("/repo", "benchmarks", "daeb", "v1", "suite.yaml"),
      suite_concept_universe_path: resolve("/repo", "benchmarks", "daeb", "v1", "suite.concepts.yaml"),
      suite_coverage_selection_path: resolve("/repo", "benchmarks", "daeb", "v1", "suite.selection.yaml"),
      suite_coverage_matrix_path: resolve("/repo", "benchmarks", "daeb", "v1", "suite.coverage.yaml"),
      suite_trace_review_path: resolve("/repo", "benchmarks", "daeb", "v1", "suite.trace-review.yaml"),
      vendor_selection_ledger_path: resolve("/repo", "benchmarks", "daeb", "v1", "vendor-selection-ledger.yaml"),
    });
  });

  it("derives vendor artifacts without hidden active-version state", () => {
    const layout = buildBenchmarkLayout("/repo", "database-agents", "2026-07");
    expect(benchmarkVendorCardPath(layout, "acme-db")).toBe(resolve(layout.vendors_dir, "acme-db.discovered.yaml"));
    expect(benchmarkVendorExtractDir(layout, "acme-db")).toBe(resolve(layout.extracts_dir, "acme-db"));
    expect(benchmarkCapabilityInventoryPath(layout, "acme-db")).toBe(resolve(layout.extracts_dir, "acme-db", "capability-inventory.yaml"));
    expect(benchmarkSurfacesPath(layout, "acme-db")).toBe(resolve(layout.extracts_dir, "acme-db", "surfaces.yaml"));
    expect(benchmarkOraclesPath(layout, "acme-db")).toBe(resolve(layout.extracts_dir, "acme-db", "oracles.yaml"));
    expect(benchmarkCompiledPackPath(layout, "acme-db")).toBe(resolve(layout.packs_dir, "acme-db", "pack.yaml"));
  });

  it("rejects traversal and nested path segments", () => {
    expect(() => buildBenchmarkLayout("/repo", "../daeb", "v1")).toThrow(/safe artifact path segment/);
    expect(() => buildBenchmarkLayout("/repo", "daeb", "v1/current")).toThrow(/safe artifact path segment/);
    const layout = buildBenchmarkLayout("/repo", "daeb", "v1");
    expect(() => benchmarkVendorCardPath(layout, "../vendor")).toThrow(/safe artifact path segment/);
    expect(() => benchmarkCompiledPackPath(layout, "/absolute")).toThrow(/safe artifact path segment/);
  });
});
